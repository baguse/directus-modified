import getDatabase, { validateDatabaseConnection } from '../../../database';
import logger from '../../../logger';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import { load as loadYaml } from 'js-yaml';
import { flushCaches } from '../../../cache';
import SchemaInspector from 'knex-schema-inspector';
import { Knex } from 'knex';
import { ForeignKey } from 'knex-schema-inspector/dist/types/foreign-key';
import progressBar from 'progressbar';

interface IResult {
	tableName: string;
	datas: any[];
	primaryKey: string;
	maxPrimaryKey: number;
}

export default async function (backupPath: string, options?: { yes: boolean }): Promise<void> {
	const filename = path.resolve(process.cwd(), backupPath);

	try {
		await fs.access(filename, fsConstants.F_OK);
	} catch {
		logger.error('Backup file does not exist.');
		process.exit(404);
	}

	const database = getDatabase();
	const dbClient: 'pg' | 'mssql' = database.client.config.client;
	let MAX_PROCESSED_DATA = 500;

	await validateDatabaseConnection(database);

	await flushCaches();

	const dropForeignKey = async (
		knex: Knex,
		tableName: string,
		columnName: string,
		foreignKeyName: string
	): Promise<boolean> => {
		const promise = new Promise((resolve, reject) => {
			const builder = knex.schema.table(tableName, (table) => {
				table.dropForeign(columnName, foreignKeyName);
			});
			builder.then((val) => resolve(val)).catch((_e) => reject(_e));
		});
		await promise;
		return true;
	};

	try {
		const fileContents = await fs.readFile(filename, 'utf8');
		let result: IResult[] = [];

		if (filename.endsWith('.yaml') || filename.endsWith('.yml')) {
			result = (await loadYaml(fileContents)) as IResult[];
		} else {
			result = JSON.parse(fileContents) as IResult[];
		}

		const inspector = SchemaInspector(database);

		const foreignKeyDatas: {
			tableName: string;
			foreignKeys: ForeignKey[];
		}[] = [];

		let errorColl = 0;
		for (const backupData of result) {
			const { tableName, datas, primaryKey, maxPrimaryKey } = backupData;
			// if (tableName != 'activities') continue;
			const foreignKeys = await inspector.foreignKeys(tableName);
			foreignKeyDatas.push({
				tableName,
				foreignKeys,
			});
			// deleting foreign keys
			const progressDropForeignKey = progressBar.create().step(`Dropping ${tableName} foreign keys...`);
			progressDropForeignKey.setTotal(foreignKeys.length);
			progressDropForeignKey.setTick(0);
			for (const foreignKey of foreignKeys) {
				const { column, constraint_name } = foreignKey;
				await dropForeignKey(database, tableName, column, constraint_name as string);
				progressDropForeignKey.addTick(1);
			}
			progressDropForeignKey.finish();
			let currentDatas: any[] = [];
			// restoring datas
			try {
				const getMaxProcessedData = () => {
					const [sampleData] = datas;
					if (sampleData) {
						const fieldCount = Object.keys(sampleData).length;
						if (fieldCount) return Math.floor(2050 / fieldCount);
					}
					return 0;
				};

				if (dbClient == 'mssql') MAX_PROCESSED_DATA = getMaxProcessedData();

				const insertData = async (tableName: string, datas: any[]) => {
					if (dbClient == 'mssql') {
						if (primaryKey) {
							const { sql, bindings } = database(tableName).insert(datas).toSQL();
							const newQuery = `SET IDENTITY_INSERT [${tableName}] ON; ${sql} SET IDENTITY_INSERT [${tableName}] OFF;`;
							return database.raw(newQuery, bindings);
						}
						return database(tableName).insert(datas);
					} else {
						return database(tableName).insert(datas);
					}
				};
				const dataLength = datas.length;
				const progress = progressBar.create().step(`Restoring ${tableName}...`);
				progress.setTotal(dataLength);
				let processed = 0;
				while (datas.length > 0) {
					currentDatas = datas.splice(0, MAX_PROCESSED_DATA);
					await insertData(tableName, currentDatas);
					processed += currentDatas.length;
					progress.setTick(processed);
				}
				progress.finish();
				logger.info(`Restored ${tableName}: ${dataLength} rows`);
			} catch (_e: any) {
				errorColl++;
				logger.error(`Failed to restore ${tableName}`);
				logger.error(_e);
			}
			// restart auto increment to current value
			if (primaryKey && maxPrimaryKey) {
				if (dbClient === 'pg') {
					await database.raw(`ALTER SEQUENCE "${tableName}_${primaryKey}_seq" RESTART WITH ${maxPrimaryKey + 1}`);
				}
			}
		}
		if (errorColl > 0) logger.error(`There are ${errorColl} errors`);

		// restoring foreign keys
		for (const foreignKeyData of foreignKeyDatas) {
			const { tableName, foreignKeys } = foreignKeyData;
			const progress = progressBar.create().step(`Restoring Foreign keys of ${tableName}...`);
			progress.setTotal(foreignKeys.length);
			for (const foreignKey of foreignKeys) {
				const { column, foreign_key_table, foreign_key_column, on_delete, on_update, constraint_name } = foreignKey;
				const builder = database.schema.alterTable(tableName, (table) => {
					table
						.foreign(column)
						.references(foreign_key_column)
						.inTable(foreign_key_table)
						.onDelete(on_delete as string)
						.onUpdate(on_update as string)
						.withKeyName(constraint_name as string);
				});
				await builder;
				progress.addTick(1);
			}
			progress.finish();
			logger.info(`Restored Foreign keys of ${tableName}: ${foreignKeys.length} `);
		}

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
