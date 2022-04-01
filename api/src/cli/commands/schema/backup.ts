import getDatabase from '../../../database';
import logger from '../../../logger';
import { getSnapshot } from '../../../utils/get-snapshot';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { dump as toYaml } from 'js-yaml';
import { flushCaches } from '../../../cache';
import { getSchema } from '../../../utils/get-schema';
import { CollectionsService, FieldsService, RelationsService, ItemsService } from '../../..';
import { CollectionsOverview, Relation } from '@directus/shared/types';
import { MailService } from '../../../services';

export async function snapshot(
	snapshotPath: string,
	options?: { yes: boolean; format: 'json' | 'yaml' }
): Promise<void> {
	const filename = path.resolve(process.cwd(), snapshotPath);

	let snapshotExists: boolean;

	try {
		await fs.access(filename, fsConstants.F_OK);
		snapshotExists = true;
	} catch {
		snapshotExists = false;
	}

	if (snapshotExists && options?.yes === false) {
		const { overwrite } = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'overwrite',
				message: 'Snapshot already exists. Do you want to overwrite the file?',
			},
		]);

		if (overwrite === false) {
			process.exit(0);
		}
	}

	await flushCaches();

	const database = getDatabase();

	const snapshot = await getSnapshot({ database });

	try {
		if (options?.format === 'yaml') {
			await fs.writeFile(filename, toYaml(snapshot));
		} else {
			await fs.writeFile(filename, JSON.stringify(snapshot));
		}

		logger.info(`Snapshot saved to ${filename}`);

		database.destroy();
		process.exit(0);
	} catch (err: any) {
		logger.error(err);
		database.destroy();
		process.exit(1);
	}
}

export default async function () {
	logger.info('Getting snapshot...');
	await flushCaches();
	const database = getDatabase();
	const schema = await getSchema({ database });
	const { collections, relations, relationMap } = schema;
	const mail = new MailService({
		schema,
		knex: database,
	});

	console.log({ mail });
	const send = await mail.send({
		html: '<h1>Hello world</h1>',
		to: 'andreanto.bagus@gmail.com',
	});

	console.log({ send });

	for (const collectionName in relationMap) {
		for (const relation of relations) {
			const { collection, field, related_collection, schema } = relation;
			if (collections[collectionName] && related_collection && schema) {
				if (!collections[collectionName].depends_on) collections[collectionName].depends_on = [];
				if (collection == collectionName) (collections[collectionName].depends_on as string[]).push(related_collection);
			}
		}
	}

	let loop = 0;
	while (Object.keys(collections).length > 0) {
		console.log(`${loop} ============================================= ${Object.keys(collections).length}`);
		for (const collectionName in collections) {
			// console.log({ collectionName });
			const collection = collections[collectionName];
			if (collection.depends_on) {
				if (!collection.depends_on.length) {
					console.log(`${collectionName} has been no dependencies ${Object.keys(collections).length}`);
					delete collections[collectionName];

					for (const currCollectionName in collections) {
						const currCollection = collections[currCollectionName];
						if (currCollection.depends_on) {
							const dependsOn = [];
							for (const dependentCollectionName of currCollection.depends_on) {
								if (dependentCollectionName != collectionName) dependsOn.push(dependentCollectionName);
							}
							// console.log({ currCollectionName, oldDepends: currCollection.depends_on, newDepends: dependsOn });
							collections[currCollectionName].depends_on = dependsOn;
						}
					}
				}
			} else {
				console.log(`${collectionName} has no dependencies ${Object.keys(collections).length}`);
				delete collections[collectionName];

				for (const currCollectionName in collections) {
					const currCollection = collections[currCollectionName];
					if (currCollection.depends_on) {
						const dependsOn = [];
						for (const dependentCollectionName of currCollection.depends_on) {
							if (dependentCollectionName != collectionName) dependsOn.push(dependentCollectionName);
						}
						// console.log({ currCollectionName, oldDepends: currCollection.depends_on, newDepends: dependsOn });
						collections[currCollectionName].depends_on = dependsOn;
					}
				}
			}
		}
		loop++;
		if (loop == 4) break;
	}

	database.destroy();
	process.exit(0);
}
