import getDatabase from '../../../database';
import logger from '../../../logger';
import progressBar from 'progressbar';

interface Table {
	collection: string;
	fields: string[];
}

export default class Locker {
	public static async lock(): Promise<void> {
		const database = getDatabase();
		const tables = await database('directus_collections')
			.select(['collection', 'schema'])
			.andWhere((qB) =>
				qB
					.whereIn('schema', ['configuration', 'datacore'])
					.where((qB) => qB.orWhere('is_external_source', false).orWhere('is_external_source', null))
			);

		const fields = await database('directus_fields')
			.orWhere('is_external_source', false)
			.orWhere('is_external_source', null)
			.orderBy('collection', 'asc');

		const tableMap: { [tableName: string]: Table } = {};

		for (const table of tables) {
			tableMap[table.collection] = { ...table, fields: [] };
		}

		for (const field of fields) {
			const { collection } = field;

			if (tableMap[collection]) {
				tableMap[collection].fields.push(field.field);
			}
		}

		for (const tableName in tableMap) {
			const { fields } = tableMap[tableName];
			logger.info(`Locking [${tableName}] ${fields.length} fields`);
			const progress = progressBar.create().step(`Locking ${tableName}...`);
			progress.setTotal(fields.length);
			for (const field of fields) {
				await database('directus_fields').update({ locked: true }).where('collection', tableName).where('field', field);
				progress.addTick(1);
			}
			progress.finish();
		}

		process.exit(0);
	}

	public static async unlock(): Promise<void> {
		const database = getDatabase();
		const tables = await database('directus_collections')
			.select(['collection', 'schema'])
			.andWhere((qB) => qB.whereIn('schema', ['public']));

		const fields = await database('directus_fields').orderBy('collection', 'asc');

		const tableMap: { [tableName: string]: Table } = {};

		for (const table of tables) {
			tableMap[table.collection] = { ...table, fields: [] };
		}

		for (const field of fields) {
			const { collection } = field;

			if (tableMap[collection]) {
				tableMap[collection].fields.push(field.field);
			}
		}

		for (const tableName in tableMap) {
			const { fields } = tableMap[tableName];
			logger.info(`Unlocking [${tableName}] ${fields.length} fields`);
			const progress = progressBar.create().step(`Unlocking ${tableName}...`);
			progress.setTotal(fields.length);
			for (const field of fields) {
				await database('directus_fields')
					.update({ locked: false })
					.where('collection', tableName)
					.where('field', field);
				progress.addTick(1);
			}
			progress.finish();
		}

		process.exit(0);
	}
}
