import getDatabase from '../../../database';
import logger from '../../../logger';
import env from '../../../env';
import path from 'path';
import fse from 'fs-extra';
import { Knex } from 'knex';

export default class Seeder {
	private static getSeederPath(): string {
		const customSeedersPath = path.resolve(env.EXTENSIONS_PATH, 'seeders');
		return customSeedersPath;
	}

	public static async generate({ name }: { name?: string }): Promise<void> {
		const customSeedersPath = Seeder.getSeederPath();
		await Seeder.checkPath();
		const now = new Date();
		const timestamp = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now
			.getDate()
			.toString()
			.padStart(2, '0')}${now.getHours().toString().padStart(2, '0')}${now
			.getMinutes()
			.toString()
			.padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
		const fileName = name?.includes('.js') ? `${timestamp}-${name}` : `${timestamp}-${name}.js`;
		await fse.writeFile(
			path.resolve(customSeedersPath, `${fileName}`),
			'module.exports = {\n\tasync up(knex) {\n\t\t// on seed up\n\n\t},\n\n\tasync down(knex) {\n    // on seed revert\n\t\t\n\t},\n};\n'
		);
		logger.info(`Seeder ${fileName} created`);
		process.exit();
	}

	public static async seedAll(): Promise<void> {
		const database = getDatabase();

		try {
			logger.info('Running Seeder...');
			let fileSeeded = 0;

			if (await Seeder.checkPath()) {
				const customSeedersPath = Seeder.getSeederPath();
				const customSeederFiles = (await fse.readdir(customSeedersPath)) || [];
				await Seeder.checkSeederMetadataTable(database);

				const currentSeederDatas = (await database.select('*').from('seeder_metadatas')).map(
					(seederData) => seederData.name
				);

				for (const seeder of customSeederFiles) {
					const pathFile = path.resolve(customSeedersPath, seeder);
					const seederInstance = require(pathFile);
					if (!currentSeederDatas.includes(seeder) && seeder.includes('.js')) {
						try {
							await seederInstance.up(database);
							logger.info(`Seed [${seeder}] successfully`);
							await database('seeder_metadatas').insert([{ name: seeder }]);
							fileSeeded++;
						} catch (e) {
							logger.error(`Failed to seed [${seeder}]`);
							logger.error(`=> ${(e as any).toString()}`);
						}
					}
				}
			}

			if (fileSeeded === 0) {
				logger.info('Database up to date');
			} else {
				logger.info(`${fileSeeded} Seeder(s) successfully seeded`);
			}

			database.destroy();
			process.exit();
		} catch (err: any) {
			logger.error(err);
			database.destroy();
			process.exit(1);
		}
	}

	public static async seed({ name }: { name?: string }): Promise<void> {
		const fileName = name?.includes('.js') ? name : `${name}.js`;
		const customSeedersPath = Seeder.getSeederPath();
		const pathFile = path.resolve(customSeedersPath, fileName);

		if (!(await fse.pathExists(pathFile))) {
			logger.error(`Seeder ${fileName} not found`);
			process.exit();
		}

		const database = getDatabase();
		const seederInstance = require(pathFile);
		await Seeder.checkSeederMetadataTable(database);
		const currentSeederDatas = (await database.select('*').from('seeder_metadatas')).map(
			(seederData) => seederData.name
		);

		if (!currentSeederDatas.includes(fileName) && fileName.includes('.js')) {
			try {
				await seederInstance.up(database);
				logger.info(`Seed [${fileName}] successfully`);
				await database('seeder_metadatas').insert([{ name: fileName }]);
			} catch (e) {
				logger.error(`Failed to seed [${fileName}]`);
				logger.debug(`=> ${(e as any).toString()}`);
			}
		} else {
			logger.info('Database up to date');
		}

		database.destroy();
		process.exit();
	}

	private static async checkPath(): Promise<boolean> {
		const customSeedersPath = Seeder.getSeederPath();
		if (!(await fse.pathExists(customSeedersPath))) {
			await fse.mkdirp(customSeedersPath);
			return false;
		}
		return true;
	}

	private static async checkSeederMetadataTable(database?: Knex) {
		if (!database) {
			const db = getDatabase();
			const tableExist = await db.schema.hasTable('seeder_metadatas');
			if (!tableExist) {
				await db.schema.createTable('seeder_metadatas', (table) => {
					table.string('name');
				});
				return false;
			}
			await db.destroy();
			return false;
		} else {
			const tableExist = await database.schema.hasTable('seeder_metadatas');
			if (!tableExist) {
				await database.schema.createTable('seeder_metadatas', (table) => {
					table.string('name');
				});
				return false;
			}
			return false;
		}
	}

	public static async revertAll() {
		const database = getDatabase();
		let reverted = 0;

		try {
			await Seeder.checkSeederMetadataTable(database);
			await Seeder.checkPath();

			const customSeedersPath = Seeder.getSeederPath();

			const currentSeederDatas = (await database.select('*').from('seeder_metadatas')).map(
				(seederData) => seederData.name
			);

			const revertCurrentSeederDatas = currentSeederDatas.reverse();

			for (const currentRevertFile of revertCurrentSeederDatas) {
				try {
					const revertFile = path.resolve(customSeedersPath, currentRevertFile);
					const revertInstance = require(revertFile);
					await revertInstance.down(database);
					await database('seeder_metadatas').where('name', currentRevertFile).del();
					logger.info(`Seed [${currentRevertFile}] successfully reverted`);
					reverted++;
				} catch (e) {
					logger.error(`Failed to revert [${currentRevertFile}]`);
					logger.debug(`=> ${(e as any).toString()}`);
				}
			}
		} catch (err: any) {
			logger.error(err);
		}
		if (reverted) {
			logger.info(`${reverted} Seeder(s) successfully reverted`);
		} else {
			logger.info('Database dont have any seeder to revert');
		}

		database.destroy();
		process.exit();
	}

	public static async revert(count: number) {
		count = Number(count);
		const database = getDatabase();
		let reverted = 0;

		try {
			await Seeder.checkSeederMetadataTable(database);
			await Seeder.checkPath();

			const customSeedersPath = Seeder.getSeederPath();

			const currentSeederDatas = (await database.select('*').from('seeder_metadatas')).map(
				(seederData) => seederData.name
			);

			const revertCurrentSeederDatas = currentSeederDatas.reverse();

			for (let i = 0; i < count; i++) {
				try {
					if (!revertCurrentSeederDatas[i]) break;
					const revertFile = path.resolve(customSeedersPath, revertCurrentSeederDatas[i]);
					const revertInstance = require(revertFile);
					await revertInstance.down(database);
					await database('seeder_metadatas').where('name', revertCurrentSeederDatas[i]).del();
					logger.info(`Seed [${revertCurrentSeederDatas[i]}] successfully reverted`);
					reverted++;
				} catch (e) {
					logger.error(`Failed to revert [${revertCurrentSeederDatas[i]}]`);
					logger.debug(`=> ${(e as any).toString()}`);
				}
			}
		} catch (err: any) {
			logger.error(err);
		}
		if (reverted) {
			logger.info(`${reverted} Seeder(s) successfully reverted`);
		} else {
			logger.info('Database dont have any seeder to revert');
		}

		database.destroy();
		process.exit();
	}
}
