import getDatabase from '../../../database';
import logger from '../../../logger';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { dump as toYaml } from 'js-yaml';
import { flushCaches } from '../../../cache';
import { getSchema } from '../../../utils/get-schema';
import { ItemsService } from '../../../services';

const excludedCollection = ['directus_collections', 'directus_fields', 'directus_migrations', 'directus_relations'];

export default async function (backupPath: string, options?: { yes: boolean; format: 'json' | 'yaml' }) {
	logger.info('Backing up data...');

	await flushCaches();
	const database = getDatabase();
	const schema = await getSchema({ database });
	const { collections } = schema;
	const filename = path.resolve(process.cwd(), backupPath);

	let backupExists: boolean;

	try {
		await fs.access(filename, fsConstants.F_OK);
		backupExists = true;
	} catch {
		backupExists = false;
	}

	if (backupExists && options?.yes === false) {
		const { overwrite } = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'overwrite',
				message: 'Backup file already exists. Do you want to overwrite the file?',
			},
		]);

		if (overwrite === false) {
			process.exit(0);
		}
	}

	const result: {
		tableName: string;
		maxPrimaryKey: number;
		datas: any[];
		primaryKey: string;
	}[] = [];

	for (const collectionName in collections) {
		if (!excludedCollection.includes(collectionName)) {
			// if (collectionName !== 'positions') continue;
			const { fields, primary } = collections[collectionName];
			const filteredFields: string[] = [];
			for (const fieldName in fields) {
				const field = fields[fieldName];
				if (!field.special.includes('o2m') && !field.special.includes('m2m') && !field.special.includes('files'))
					filteredFields.push(fieldName);
			}
			const primaryKeyData = fields[primary];
			let primaryKey = '';
			if (primaryKeyData) {
				if (!primaryKeyData.special.includes('uuid') && primaryKeyData.defaultValue == 'AUTO_INCREMENT') {
					primaryKey = primaryKeyData.field;
				}
			}
			// const datas = await database.select('*').from(collectionName);
			const itemService = new ItemsService(collectionName, {
				schema,
				accountability: {
					user: '-',
					role: '-',
					admin: true,
					app: true,
					ip: '::1',
					userAgent: 'System/1.0.0',
					share: undefined,
					share_scope: undefined,
					permissions: [],
				},
				knex: database,
			});
			let datas: any[] = [];
			let appendDatas = [];
			const MAX_DATA = 2000;
			let page = 1;
			let maxPrimaryKey = 0;
			do {
				appendDatas = await itemService.readByQuery(
					{
						fields: filteredFields,
						limit: MAX_DATA,
						page: page,
						showSoftDelete: true,
					},
					{
						transformers: {
							conceal: false,
							hash: false,
							json: false,
							'json-stringify': true,
						},
					}
				);
				if (appendDatas.length) datas = [...datas, ...appendDatas];
				if (primaryKey) {
					for (const currData of appendDatas) {
						const primaryKeyValue = currData[primaryKey];
						if (primaryKeyValue > maxPrimaryKey) {
							maxPrimaryKey = primaryKeyValue;
						}
					}
				}
				page++;
			} while (appendDatas.length);
			if (datas.length) {
				result.push({
					tableName: collectionName,
					datas,
					maxPrimaryKey,
					primaryKey,
				});
				logger.info(`Backed up ${collectionName}: ${datas.length} rows`);
			} else {
				logger.warn(`No data found for ${collectionName}. Skipping...`);
			}
		}
	}

	try {
		if (options?.format === 'yaml') {
			await fs.writeFile(filename, toYaml(result));
		} else {
			await fs.writeFile(filename, JSON.stringify(result));
		}

		const sizeFile = (await fs.stat(filename)).size / 1024;
		logger.info(`Backup saved to ${filename} (${sizeFile.toFixed(3)} KB)`);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}
