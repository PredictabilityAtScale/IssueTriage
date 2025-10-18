import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

import initSqlJs, { Database, SqlJsStatic, SqlValue } from 'sql.js';

export interface AssessmentRecord {
	id?: number;
	repository: string;
	issueNumber: number;
	compositeScore: number;
	requirementsScore: number;
	complexityScore: number;
	securityScore: number;
	businessScore: number;
	recommendations: string[];
	summary: string;
	model: string;
	commentId?: number;
	createdAt: string;
	rawResponse?: string;
}

export class AssessmentStorage {
	private db: Database | undefined;
	private sql: SqlJsStatic | undefined;
	private readonly dbPath: string;
	private initPromise: Promise<void> | undefined;
	private readonly require = createRequire(path.join(__dirname, 'assessmentStorage.cjs'));
	private wasmPath: string | undefined;

	constructor(private readonly storageDir: string) {
		this.dbPath = path.join(storageDir, 'assessments.db');
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

	public async saveAssessment(record: AssessmentRecord): Promise<AssessmentRecord> {
		await this.initialize();
		const db = this.ensureDb();
		const recommendationsJson = JSON.stringify(record.recommendations ?? []);
		const rawResponse = record.rawResponse ?? null;
		const commentId = record.commentId ?? null;

		this.run(
			`INSERT INTO assessments (
				repository,
				issue_number,
				composite_score,
				requirements_score,
				complexity_score,
				security_score,
				business_score,
				recommendations,
				summary,
				model,
				comment_id,
				created_at,
				raw_response
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				record.repository,
				record.issueNumber,
				record.compositeScore,
				record.requirementsScore,
				record.complexityScore,
				record.securityScore,
				record.businessScore,
				recommendationsJson,
				record.summary,
				record.model,
				commentId,
				record.createdAt,
				rawResponse
			]
		);

		const idRow = this.query(`SELECT last_insert_rowid() as id`);
		const insertedId = Number(idRow[0]?.id ?? 0);
		await this.persist();
		return { ...record, id: insertedId };
	}

	public async getLatestAssessment(repository: string, issueNumber: number): Promise<AssessmentRecord | undefined> {
		await this.initialize();
		const rows = this.query(
			`SELECT * FROM assessments
			WHERE repository = ? AND issue_number = ?
			ORDER BY datetime(created_at) DESC
			LIMIT 1`,
			[repository, issueNumber]
		);

		if (!rows.length) {
			return undefined;
		}
		return this.mapRow(rows[0]);
	}

	public async getAssessments(repository: string, issueNumber: number, limit = 20): Promise<AssessmentRecord[]> {
		await this.initialize();
		const rows = this.query(
			`SELECT * FROM assessments
			WHERE repository = ? AND issue_number = ?
			ORDER BY datetime(created_at) DESC
			LIMIT ?`,
			[repository, issueNumber, limit]
		);
		return rows.map(row => this.mapRow(row));
	}

	private mapRow(row: Record<string, unknown>): AssessmentRecord {
		const recommendationsRaw = typeof row.recommendations === 'string' ? row.recommendations : '[]';
		let recommendations: string[] = [];
		try {
			const parsed = JSON.parse(recommendationsRaw);
			if (Array.isArray(parsed)) {
				recommendations = parsed.filter((item: unknown): item is string => typeof item === 'string').map(item => item.trim()).filter(item => item.length > 0);
			}
		} catch (error) {
			console.warn('Failed to parse assessment recommendations payload.', error);
		}

		return {
			id: typeof row.id === 'number' ? row.id : Number(row.id ?? 0) || undefined,
			repository: String(row.repository ?? ''),
			issueNumber: Number(row.issue_number ?? 0),
			compositeScore: Number(row.composite_score ?? 0),
			requirementsScore: Number(row.requirements_score ?? 0),
			complexityScore: Number(row.complexity_score ?? 0),
			securityScore: Number(row.security_score ?? 0),
			businessScore: Number(row.business_score ?? 0),
			recommendations,
			summary: String(row.summary ?? ''),
			model: String(row.model ?? ''),
			commentId: row.comment_id === null || row.comment_id === undefined ? undefined : Number(row.comment_id),
			createdAt: String(row.created_at ?? ''),
			rawResponse: typeof row.raw_response === 'string' ? row.raw_response : undefined
		};
	}

	private ensureDb(): Database {
		if (!this.db) {
			throw new Error('Assessment database not initialized. Call initialize() first.');
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
		db.run(`CREATE TABLE IF NOT EXISTS assessments (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			repository TEXT NOT NULL,
			issue_number INTEGER NOT NULL,
			composite_score REAL NOT NULL,
			requirements_score REAL NOT NULL,
			complexity_score REAL NOT NULL,
			security_score REAL NOT NULL,
			business_score REAL NOT NULL,
			recommendations TEXT NOT NULL,
			summary TEXT NOT NULL,
			model TEXT NOT NULL,
			comment_id INTEGER,
			created_at TEXT NOT NULL,
			raw_response TEXT
		);`);
		db.run(`CREATE INDEX IF NOT EXISTS idx_assessments_repo_issue ON assessments (repository, issue_number, created_at DESC);`);
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
