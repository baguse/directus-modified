import { Knex } from 'knex';
import { nanoid } from 'nanoid';
import runMigrations from '../../../database/migrations/run';
import installDatabase from '../../../database/seeds/run';
import env from '../../../env';
import logger from '../../../logger';
import { getSchema } from '../../../utils/get-schema';
import { RolesService, UsersService, SettingsService } from '../../../services';

import getDatabase, { isInstalled, validateDatabaseConnection, hasDatabaseConnection } from '../../../database';
import { SchemaOverview } from '@directus/shared/types';
import { defaultAdminRole, defaultAdminUser } from '../../utils/defaults';

export default async function bootstrap({ skipAdminInit }: { skipAdminInit?: boolean }): Promise<void> {
	logger.info('Initializing bootstrap...');

	const database = getDatabase();

	await waitForDatabase(database);

	if ((await isInstalled()) === false) {
		logger.info('Installing Directus system tables...');

		await installDatabase(database);

		logger.info('Running migrations...');
		await runMigrations(database, 'latest');

		const schema = await getSchema();

		if (skipAdminInit == null) {
			await createDefaultAdmin(schema);
		} else {
			logger.info('Skipping creation of default Admin user and role...');
		}

		if (env.PROJECT_NAME && typeof env.PROJECT_NAME === 'string' && env.PROJECT_NAME.length > 0) {
			const settingsService = new SettingsService({ schema });
			await settingsService.upsertSingleton({ project_name: env.PROJECT_NAME });
		}
	} else {
		logger.info('Database already initialized, skipping install');
		logger.info('Running migrations...');
		await runMigrations(database, 'latest');
	}

	logger.info('Done');
	process.exit(0);
}

async function waitForDatabase(database: Knex) {
	const tries = 5;
	const secondsBetweenTries = 5;

	for (let i = 0; i < tries; i++) {
		if (await hasDatabaseConnection(database)) {
			return true;
		}

		await new Promise((resolve) => setTimeout(resolve, secondsBetweenTries * 1000));
	}

	// This will throw and exit the process if the database is not available
	await validateDatabaseConnection(database);
}

async function createDefaultAdmin(schema: SchemaOverview) {
	logger.info('Setting up first admin role...');
	const rolesService = new RolesService({ schema });
	const role = await rolesService.createOne(defaultAdminRole);

	logger.info('Adding first admin user...');
	const usersService = new UsersService({ schema });

	let adminEmail = env.ADMIN_EMAIL;

	if (!adminEmail) {
		logger.info('No admin email provided. Defaulting to "admin@machinevision.global"');
		adminEmail = 'admin@machinevision.global';
	}

	let adminPassword = env.ADMIN_PASSWORD || 'laniuslab';

	if (!adminPassword) {
		adminPassword = nanoid(12);
		logger.info(`No admin password provided. Defaulting to "${adminPassword}"`);
	}

	await usersService.createOne({ email: adminEmail, password: adminPassword, role, ...defaultAdminUser });
}
