import { Command, Option } from 'commander';
import { startServer } from '../server';
import emitter from '../emitter';
import { getExtensionManager } from '../extensions';
import bootstrap from './commands/bootstrap';
import count from './commands/count';
import dbInstall from './commands/database/install';
import dbMigrate from './commands/database/migrate';
import dbSeed from './commands/database/seed';
import dbLocker from './commands/database/lock';
import init from './commands/init';
import rolesCreate from './commands/roles/create';
import usersCreate from './commands/users/create';
import usersPasswd from './commands/users/passwd';
import { snapshot } from './commands/schema/snapshot';
import { apply } from './commands/schema/apply';
import schemaBackup from './commands/schema/backup';
import schemaRestore from './commands/schema/restore';
import OAS from './commands/oas/export';

const pkg = require('../../package.json');

export async function createCli(): Promise<Command> {
	const program = new Command();

	const extensionManager = getExtensionManager();

	await extensionManager.initialize({ schedule: false, watch: false });

	await emitter.emitInit('cli.before', { program });

	program.name('directus').usage('[command] [options]');
	program.version(pkg.version, '-v, --version');

	program.command('start').description('Start the Directus API').action(startServer);
	program.command('init').description('Create a new Directus Project').action(init);

	const dbCommand = program.command('database');
	dbCommand.command('install').description('Install the database').action(dbInstall);
	dbCommand
		.command('migrate:latest')
		.description('Upgrade the database')
		.action(() => dbMigrate('latest'));
	dbCommand
		.command('migrate:up')
		.description('Upgrade the database')
		.action(() => dbMigrate('up'));
	dbCommand
		.command('migrate:down')
		.description('Downgrade the database')
		.action(() => dbMigrate('down'));
	dbCommand
		.command('generate:seed')
		.description('Generate seeder file')
		.option('-n, --name <value>', 'The seeder name')
		.action(dbSeed.generate);
	dbCommand.command('seed:all').description('Seed all the database').action(dbSeed.seedAll);
	dbCommand
		.command('seed')
		.description('Seed one seeder')
		.option('-n, --name <value>', 'The seeder to run')
		.action(dbSeed.seed);
	dbCommand.command('revert:all').description('Revert all Seeder(s)').action(dbSeed.revertAll);
	dbCommand
		.command('revert')
		.description('Revert some seeder')
		.argument('<count>', 'The number of seeder to revert')
		.action(dbSeed.revert);
	dbCommand.command('lock').description('Lock Configuration and Datacore fields').action(dbLocker.lock);
	dbCommand.command('unlock').description('Unlock Public fields').action(dbLocker.unlock);
	const usersCommand = program.command('users');

	usersCommand
		.command('create')
		.description('Create a new user')
		.option('--email <value>', `user's email`)
		.option('--password <value>', `user's password`)
		.option('--role <value>', `user's role`)
		.action(usersCreate);

	usersCommand
		.command('passwd')
		.description('Set user password')
		.option('--email <value>', `user's email`)
		.option('--password <value>', `user's new password`)
		.action(usersPasswd);

	const rolesCommand = program.command('roles');
	rolesCommand
		.command('create')
		.description('Create a new role')
		.option('--role <value>', `name for the role`)
		.option('--admin', `whether or not the role has admin access`)
		.action(rolesCreate);

	program.command('count <collection>').description('Count the amount of items in a given collection').action(count);

	program
		.command('bootstrap')
		.description('Initialize or update the database')
		.option('--skipAdminInit', 'Skips the creation of the default Admin Role and User')
		.action(bootstrap);

	const schemaCommands = program.command('schema');

	schemaCommands
		.command('snapshot')
		.description('Create a new Schema Snapshot')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`, false)
		.addOption(new Option('--format <format>', 'JSON or YAML format').choices(['json', 'yaml']).default('yaml'))
		.addOption(new Option('--collection [collections...]', 'specify collections'))
		.argument('<path>', 'Path to snapshot file')
		.action(snapshot);

	schemaCommands
		.command('apply')
		.description('Apply a snapshot file to the current database')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`)
		.option('-d, --dry-run', 'Plan and log changes to be applied', false)
		.argument('<path>', 'Path to snapshot file')
		.action(apply);

	schemaCommands
		.command('backup')
		.description('Backup the current database')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`, false)
		.addOption(new Option('--format <format>', 'JSON or YAML format').choices(['json', 'yaml']).default('yaml'))
		.argument('<path>', 'Path to Backup file')
		.action(schemaBackup);

	schemaCommands
		.command('restore')
		.description('Restore backup file to the current database')
		.option('-y, --yes', `Assume "yes" as answer to all prompts and run non-interactively`)
		.argument('<path>', 'Path to Backup file')
		.action(schemaRestore);

	const oasCommands = program.command('oas');
	oasCommands
		.command('export:file')
		.description('Save the OpenAPI specification')
		.argument('<filename>', 'Filename')
		.action(OAS.saveToFile);

	oasCommands.command('export').description('Print the OpenAPI specification').action(OAS.printJson);

	await emitter.emitInit('cli.after', { program });

	return program;
}
