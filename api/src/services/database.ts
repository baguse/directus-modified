import knex, { Knex } from 'knex';
import SchemaInspector from 'knex-schema-inspector';
import { Table } from 'knex-schema-inspector/dist/types/table';
import { merge } from 'lodash';
import { MongoClient } from 'mongodb';

interface IDBaseConfig {
	dbClient: 'sqlite3' | 'oracledb' | 'cockroachdb' | 'pg' | 'mysql' | 'mariadb' | 'mssql' | 'mongodb';
	dbHost?: string;
	dbPort?: number;
	dbDatabase?: string;
	dbUser?: string;
	dbPassword?: string;
	dbConnectionString?: string;
}

interface IDBaseList {
	name: string;
	schema?: string;
}

interface ITableInfo extends Table {
	primaryKey?: string | null;
}

export class DatabaseService {
	config: IDBaseConfig | null = null;
	knexConfig: Knex.Config | null = null;
	database: Knex | MongoClient = {} as Knex;
	constructor(options: { config: IDBaseConfig }) {
		if (!options.config) throw new Error('Database config is required');
		this.config = options.config;
		const { dbClient, dbDatabase, dbHost, dbPassword, dbPort, dbUser, dbConnectionString } = options.config;

		const config = {
			host: dbHost,
			database: dbDatabase,
			password: dbPassword,
			port: dbPort,
			user: dbUser,
		};

		if (dbClient !== 'mongodb') {
			this.knexConfig = {
				client: dbClient,
				connection: dbConnectionString || config,
			};
		} else {
			this.config = {
				dbClient: 'mongodb',
				dbConnectionString:
					dbConnectionString || `mongodb://${dbUser}:${dbPassword}@${dbHost || 271017}:${dbPort}/${dbDatabase}`,
			};
		}

		switch (dbClient) {
			case 'mssql':
				merge(this.knexConfig, { connection: { options: { useUTC: false } } });
				break;
		}

		if (dbClient !== 'mongodb') {
			this.database = knex(this.knexConfig as Knex.Config);
		}
	}

	public async testConnection() {
		if (this.config?.dbClient === 'mongodb') {
			try {
				this.database = await MongoClient.connect(this.config.dbConnectionString as string);
				return true;
			} catch (e) {
				return false;
			}
		} else {
			try {
				await (this.database as Knex).raw('SELECT 1');
				return true;
			} catch (err) {
				return false;
			}
		}
	}

	public async getDatabases(): Promise<IDBaseList[]> {
		const isConnect = await this.testConnection();
		if (!isConnect) throw 'Database connection failed';
		if (this.config?.dbClient === 'mssql') {
			return (this.database as Knex).raw('SELECT name FROM sys.databases');
		} else if (this.config?.dbClient == 'pg') {
			const results = await (this.database as Knex).raw('SELECT datname as name FROM pg_database');
			return results.rows;
		} else if (this.config?.dbClient == 'mysql' || this.config?.dbClient == 'mariadb') {
			const results: any[][] = (await (this.database as Knex).raw('SHOW DATABASES')) as any[][];
			return results[0].map((x) => {
				return {
					name: x.Database,
				};
			});
		} else if (this.config?.dbClient == 'mongodb') {
			const results = await (this.database as MongoClient).db('admin').admin().listDatabases();
			return results.databases.map((x) => {
				return {
					name: x.name,
				};
			});
		}
		return [];
	}

	public async getTables(database?: string) {
		const isConnect = await this.testConnection();
		if (!isConnect) throw 'Database connection failed';
		if (this.config?.dbClient == 'mongodb') {
			return (await (this.database as MongoClient).db(database).listCollections().toArray()).map((x) => {
				return {
					name: x.name,
				};
			});
		} else {
			return (await SchemaInspector(this.database as Knex).tables()).map((tableName) => {
				return {
					name: tableName,
				};
			});
		}
	}

	public async getTablesInfo(database?: string) {
		const isConnect = await this.testConnection();
		if (!isConnect) throw 'Database connection failed';
		if (this.config?.dbClient == 'mongodb') {
			return (this.database as MongoClient).db(database).listCollections().toArray();
		} else {
			const tablesInfos: ITableInfo[] = await SchemaInspector(this.database as Knex).tableInfo();
			for (const tableInfo of tablesInfos) {
				tableInfo.primaryKey = await SchemaInspector(this.database as Knex).primary(tableInfo.name);
			}
			return tablesInfos;
		}
	}

	public async getColumns(tableName: string) {
		const isConnect = await this.testConnection();
		if (!isConnect) throw 'Database connection failed';
		if (this.config?.dbClient == 'mongodb') {
			const sampleData = await (this.database as MongoClient)
				.db(this.config.dbDatabase as string)
				.collection(tableName)
				.findOne(
					{},
					{
						projection: {
							__v: 0,
						},
					}
				);
			const fields = Object.keys(sampleData || {}).map((x) => ({ name: x }));
			return fields;
		} else {
			return (await SchemaInspector(this.database as Knex).columns(tableName)).map((columnInfo) => {
				return {
					name: columnInfo.column,
				};
			});
		}
	}

	public async getColumnsInfo(tableName: string) {
		const isConnect = await this.testConnection();
		if (!isConnect) throw 'Database connection failed';
		if (this.config?.dbClient == 'mongodb') {
			const sampleData = await (this.database as MongoClient)
				.db(this.config.dbDatabase as string)
				.collection(tableName)
				.findOne(
					{},
					{
						projection: {
							__v: 0,
						},
					}
				);
			const fields = Object.keys(sampleData || {}).map((x) => ({ name: x }));
			return fields;
		} else {
			return SchemaInspector(this.database as Knex).columnInfo(tableName);
		}
	}

	public async getForeignKeys(tableName?: string) {
		const isConnect = await this.testConnection();
		if (!isConnect) throw 'Database connection failed';
		if (this.config?.dbClient == 'mongodb') {
			return [];
		} else {
			return SchemaInspector(this.database as Knex).foreignKeys(tableName);
		}
	}

	public async destroy() {
		if (this.config?.dbClient != 'mongodb') {
			await (this.database as Knex).destroy();
		}
		return true;
	}
}
