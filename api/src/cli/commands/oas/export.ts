import getDatabase, { isInstalled } from '../../../database';
import logger from '../../../logger';
import path from 'path';
import fse from 'fs-extra';
import { getSchema } from '../../../utils/get-schema';
import { SpecificationService } from '../../..';
import { flushCaches } from '../../../cache';

export default class OAS {
	public static async generate() {
		const excludedPaths = ['POST:/auth/login'];
		const database = getDatabase();
		await flushCaches();

		if ((await isInstalled()) === false) {
			logger.error(`Directus isn't installed on this database. Please run "directus bootstrap" first.`);
			database.destroy();
			process.exit(0);
		}
		const schema = await getSchema({
			database,
		});
		const service = new SpecificationService({
			accountability: {
				user: null,
				role: null,
				admin: true,
				app: true,
				ip: '::1',
				userAgent: 'System/1.0.0',
				share: undefined,
				share_scope: undefined,
				permissions: [],
			},
			schema: schema,
		});
		const json = await service.oas.generate();
		const auth = [{ Auth: [] }, { bearer: [] }];
		if (json.components?.securitySchemes)
			json.components.securitySchemes.bearer = {
				scheme: 'bearer',
				bearerFormat: 'JWT',
				type: 'http',
			};
		for (const path in json.paths) {
			for (const method in json.paths[path]) {
				if (!excludedPaths.includes(`${method.toUpperCase()}:${path}`)) json.paths[path][method].security = auth;
			}
		}
		await database.destroy();

		return json;
	}

	public static async saveToFile(filename: string) {
		const filepath = path.resolve(process.cwd(), filename);
		const json = await OAS.generate();
		fse.writeFileSync(filepath, JSON.stringify(json, null, 2));
		logger.info(`OAS specification saved to ${filepath}`);
		process.exit();
	}

	public static async printJson() {
		console.log(await OAS.generate());
		process.exit();
	}
}
