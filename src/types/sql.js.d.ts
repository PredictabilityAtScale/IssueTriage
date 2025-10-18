declare module 'sql.js' {
	export type SqlValue = string | number | null | Uint8Array;

	export interface Statement {
		bind(values?: SqlValue[] | Record<string, SqlValue>): boolean;
		step(): boolean;
		getAsObject(): Record<string, unknown>;
		free(): void;
	}

	export interface Database {
		run(sql: string): void;
		prepare(sql: string): Statement;
		export(): Uint8Array;
		close(): void;
	}

	export interface SqlJsStatic {
		Database: new (data?: Uint8Array) => Database;
	}

	export interface SqlJsConfig {
		locateFile?: (file: string) => string;
	}

	export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
