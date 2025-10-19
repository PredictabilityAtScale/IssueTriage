import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

import initSqlJs, { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { RiskProfile } from '../types/risk';

const DATABASE_FILENAME = 'risk-profiles.db';

export interface RiskProfileStore {
	initialize(): Promise<void>;
	dispose(): Promise<void>;
	saveProfile(profile: RiskProfile): Promise<void>;
	getProfile(repository: string, issueNumber: number): Promise<RiskProfile | undefined>;
	getProfiles(repository: string, issueNumbers: number[]): Promise<RiskProfile[]>;
}

export class RiskStorage implements RiskProfileStore {
	private db: Database | undefined;
	private sql: SqlJsStatic | undefined;
	private readonly dbPath: string;
	private initPromise: Promise<void> | undefined;
	private readonly require = createRequire(path.join(__dirname, 'riskStorage.cjs'));
	private wasmPath: string | undefined;

	constructor(private readonly storageDir: string) {
		this.dbPath = path.join(storageDir, DATABASE_FILENAME);
	}

	public async initialize(): Promise<void> {
		if (this.initPromise) {
			return this.initPromise;
		}
		this.initPromise = this.openDatabase();
		return this.initPromise;
	}

	public async dispose(): Promise<void> {
		if (!this.db) {
			return;
		}
		await this.persist();
		this.db.close();
		this.db = undefined;
	}

	public async saveProfile(profile: RiskProfile): Promise<void> {
		await this.initialize();
		const db = this.ensureDb();
		const metricsJson = JSON.stringify(profile.metrics ?? {});
		const evidenceJson = JSON.stringify(profile.evidence ?? []);
		const driversJson = JSON.stringify(profile.drivers ?? []);
		const filtersJson = JSON.stringify(profile.labelFilters ?? []);

		this.run(
			`INSERT INTO risk_profiles (
				repository,
				issue_number,
				risk_level,
				risk_score,
				metrics,
				evidence,
				drivers,
				lookback_days,
				label_filters,
				calculated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(repository, issue_number) DO UPDATE SET
				risk_level = excluded.risk_level,
				risk_score = excluded.risk_score,
				metrics = excluded.metrics,
				evidence = excluded.evidence,
				drivers = excluded.drivers,
				lookback_days = excluded.lookback_days,
				label_filters = excluded.label_filters,
				calculated_at = excluded.calculated_at`,
			[
				profile.repository,
				profile.issueNumber,
				profile.riskLevel,
				profile.riskScore,
				metricsJson,
				evidenceJson,
				driversJson,
				profile.lookbackDays,
				filtersJson,
				profile.calculatedAt
			]
		);
		await this.persist();
	}

	public async getProfile(repository: string, issueNumber: number): Promise<RiskProfile | undefined> {
		await this.initialize();
		const rows = this.query(
			`SELECT * FROM risk_profiles WHERE repository = ? AND issue_number = ? LIMIT 1`,
			[repository, issueNumber]
		);
		if (!rows.length) {
			return undefined;
		}
		return this.mapRow(rows[0]);
	}

	public async getProfiles(repository: string, issueNumbers: number[]): Promise<RiskProfile[]> {
		await this.initialize();
		if (issueNumbers.length === 0) {
			return [];
		}
		const placeholders = issueNumbers.map(() => '?').join(', ');
		const rows = this.query(
			`SELECT * FROM risk_profiles
			WHERE repository = ? AND issue_number IN (${placeholders})`,
			[repository, ...issueNumbers]
		);
		return rows.map(row => this.mapRow(row));
	}

	private mapRow(row: Record<string, unknown>): RiskProfile {
		return {
			repository: String(row.repository ?? ''),
			issueNumber: Number(row.issue_number ?? 0),
			riskLevel: String(row.risk_level ?? 'low') as RiskProfile['riskLevel'],
			riskScore: Number(row.risk_score ?? 0),
			metrics: (() => {
				const fallback: RiskProfile['metrics'] = {
					prCount: 0,
					filesTouched: 0,
					totalAdditions: 0,
					totalDeletions: 0,
					changeVolume: 0,
					reviewCommentCount: 0,
					directCommitCount: 0,
					directCommitAdditions: 0,
					directCommitDeletions: 0,
					directCommitChangeVolume: 0
				};
				const parsed = this.parseJson(row.metrics, fallback);
				return { ...fallback, ...parsed };
			})(),
			evidence: this.parseJson(row.evidence, []),
			drivers: this.parseJson(row.drivers, []),
			lookbackDays: Number(row.lookback_days ?? 0),
			labelFilters: this.parseJson(row.label_filters, []),
			calculatedAt: String(row.calculated_at ?? '')
		};
	}

	private parseJson<T>(value: unknown, fallback: T): T {
		if (typeof value === 'string' && value.length) {
			try {
				const parsed = JSON.parse(value);
				return parsed as T;
			} catch (error) {
				console.warn('Failed to parse risk storage JSON payload.', error);
			}
		}
		return fallback;
	}

	private ensureDb(): Database {
		if (!this.db) {
			throw new Error('Risk storage database not initialized. Call initialize() first.');
		}
		return this.db;
	}

	private async openDatabase(): Promise<void> {
		await fs.promises.mkdir(this.storageDir, { recursive: true });
		const SQL = await this.loadSqlModule();
		const existing = await this.readDatabaseFile();
		this.db = existing ? new SQL.Database(existing) : new SQL.Database();
		this.applyMigrations();
		await this.persist();
	}

	private applyMigrations(): void {
		const db = this.ensureDb();
		db.run(`CREATE TABLE IF NOT EXISTS risk_profiles (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			repository TEXT NOT NULL,
			issue_number INTEGER NOT NULL,
			risk_level TEXT NOT NULL,
			risk_score REAL NOT NULL,
			metrics TEXT NOT NULL,
			evidence TEXT NOT NULL,
			drivers TEXT NOT NULL,
			lookback_days INTEGER NOT NULL,
			label_filters TEXT NOT NULL,
			calculated_at TEXT NOT NULL,
			UNIQUE(repository, issue_number)
		);`);
		db.run(`CREATE INDEX IF NOT EXISTS idx_risk_profiles_repo_issue ON risk_profiles (repository, issue_number);`);
	}

	private run(sql: string, params: SqlValue[] = []): void {
		const db = this.ensureDb();
		const statement = db.prepare(sql);
		try {
			statement.bind(params);
			statement.step();
		} finally {
			statement.free();
		}
	}

	private query(sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
		const db = this.ensureDb();
		const statement = db.prepare(sql);
		try {
			statement.bind(params);
			const rows: Record<string, unknown>[] = [];
			while (statement.step()) {
				rows.push(statement.getAsObject());
			}
			return rows;
		} finally {
			statement.free();
		}
	}

	private async persist(): Promise<void> {
		const db = this.ensureDb();
		const data = db.export();
		await fs.promises.writeFile(this.dbPath, Buffer.from(data));
	}

	private async readDatabaseFile(): Promise<Uint8Array | undefined> {
		try {
			const content = await fs.promises.readFile(this.dbPath);
			return new Uint8Array(content);
		} catch (error) {
			const nodeError = error as NodeJS.ErrnoException;
			if (nodeError.code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	}

	private async loadSqlModule(): Promise<SqlJsStatic> {
		if (this.sql) {
			return this.sql;
		}
		if (!this.wasmPath) {
			this.wasmPath = this.require.resolve('sql.js/dist/sql-wasm.wasm');
		}
		this.sql = await initSqlJs({
			locateFile: () => this.wasmPath ?? 'sql-wasm.wasm'
		});
		return this.sql;
	}
}
