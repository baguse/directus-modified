import path from 'path';
import chalk from 'chalk';
import fse from 'fs-extra';
import execa from 'execa';
import ora from 'ora';
import { EXTENSION_TYPES, EXTENSION_PKG_KEY, EXTENSION_LANGUAGES } from '@directus/shared/constants';
import { isAppExtension, isExtension } from '@directus/shared/utils';
import { ExtensionType } from '@directus/shared/types';
import log from '../utils/logger';
import { isLanguage, languageToShort } from '../utils/languages';
import renameMap from '../utils/rename-map';
import { Language } from '../types';
import getPackageVersion from '../utils/get-package-version';

const pkg = require('../../../../package.json');

const TEMPLATE_PATH = path.resolve(__dirname, '../../../../templates');

type CreateOptions = { language: string; isUsedDecorator?: boolean };

export default async function create(type: string, name: string, options: CreateOptions): Promise<void> {
	const targetPath = path.resolve(name);

	if (!isExtension(type)) {
		log(
			`Extension type ${chalk.bold(type)} does not exist. Available extension types: ${EXTENSION_TYPES.map((t) =>
				chalk.bold.magenta(t)
			).join(', ')}.`,
			'error'
		);
		process.exit(1);
	}

	if (await fse.pathExists(targetPath)) {
		const info = await fse.stat(targetPath);

		if (!info.isDirectory()) {
			log(`Destination ${chalk.bold(name)} already exists and is not a directory.`, 'error');
			process.exit(1);
		}

		const files = await fse.readdir(targetPath);

		if (files.length > 0) {
			log(`Destination ${chalk.bold(name)} already exists and is not empty.`, 'error');
			process.exit(1);
		}
	}

	if (!isLanguage(options.language)) {
		log(
			`Language ${chalk.bold(options.language)} is not supported. Available languages: ${EXTENSION_LANGUAGES.map((t) =>
				chalk.bold.magenta(t)
			).join(', ')}.`,
			'error'
		);
		process.exit(1);
	}

	const spinner = ora(`Scaffolding MV Datacore extension...`).start();

	await fse.ensureDir(targetPath);

	await fse.copy(path.join(TEMPLATE_PATH, 'common', options.language), targetPath);
	if (type == 'endpoint' && options.language === 'typescript') {
		if (options.isUsedDecorator) {
			await fse.copy(path.join(TEMPLATE_PATH, type, options.language, 'withDecorator'), targetPath);
		} else {
			await fse.copy(path.join(TEMPLATE_PATH, type, options.language, 'notWithDecorator'), targetPath);
		}
	} else {
		await fse.copy(path.join(TEMPLATE_PATH, type, options.language), targetPath);
	}
	await renameMap(targetPath, (name) => (name.startsWith('_') ? `.${name.substring(1)}` : null));

	const packageManifest = {
		name: `mv-data-core-extension-${name}`,
		version: '1.0.0',
		keywords: ['mv-datacore', 'mv-datacore-extension', `mv-datacore-custom-${type}`],
		[EXTENSION_PKG_KEY]: {
			type,
			path: 'dist/index.js',
			source: `src/index.${languageToShort(options.language)}`,
			host: `^${pkg.version}`,
		},
		scripts: {
			build: 'directus-extension build',
		},
		devDependencies: await getPackageDeps(type, options.language),
	};

	await fse.writeJSON(path.join(targetPath, 'package.json'), packageManifest, { spaces: '\t' });

	await execa('yarn', ['install'], { cwd: targetPath });

	spinner.succeed(chalk.bold('Done'));

	log(`
Your ${type} extension has been created at ${chalk.green(targetPath)}

Build your extension by running:
  ${chalk.blue('cd')} ${name}
  ${chalk.blue('yarn run')} build
	`);
}

async function getPackageDeps(type: ExtensionType, language: Language) {
	if (isAppExtension(type)) {
		return {
			'@directus/extensions-sdk': `npm:@mv-data-core/extensions-sdk@${pkg.version}`,
			...(language === 'typescript'
				? {
						typescript: `^${await getPackageVersion('typescript')}`,
				  }
				: {}),
			vue: `^${await getPackageVersion('vue')}`,
		};
	} else {
		if (type == 'endpoint' && language === 'typescript') {
			return {
				'@directus/extensions-sdk': `npm:@mv-data-core/extensions-sdk@${pkg.version}`,
				'@types/node': `^${await getPackageVersion('@types/node')}`,
				typescript: `^${await getPackageVersion('typescript')}`,
				'@mv-data-core/decorator': '0.0.2',
				'@mv-data-core/shared': '9.5.3',
			};
		}
		return {
			'@directus/extensions-sdk': `npm:@mv-data-core/extensions-sdk@${pkg.version}`,
			...(language === 'typescript'
				? {
						'@types/node': `^${await getPackageVersion('@types/node')}`,
						typescript: `^${await getPackageVersion('typescript')}`,
				  }
				: {}),
		};
	}
}
