import express, { NextFunction, Router, Response as ExpressResponse, Request as ExpressRequest } from 'express';
import path from 'path';
import 'reflect-metadata';
import {
	ActionHandler,
	AppExtensionType,
	EndpointConfig,
	Extension,
	ExtensionType,
	FilterHandler,
	HookConfig,
	InitHandler,
	ScheduleHandler,
} from '@directus/shared/types';
import {
	ensureExtensionDirs,
	generateExtensionsEntry,
	getLocalExtensions,
	getPackageExtensions,
	resolvePackage,
} from '@directus/shared/utils/node';
import {
	API_EXTENSION_PACKAGE_TYPES,
	API_EXTENSION_TYPES,
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	EXTENSION_PACKAGE_TYPES,
	EXTENSION_TYPES,
} from '@directus/shared/constants';
import getDatabase from './database';
import emitter, { Emitter } from './emitter';
import env from './env';
import * as exceptions from './exceptions';
import * as sharedExceptions from '@directus/shared/exceptions';
import logger from './logger';
import fse from 'fs-extra';
import { getSchema } from './utils/get-schema';

import * as services from './services';
import { schedule, ScheduledTask, validate } from 'node-cron';
import { rollup } from 'rollup';
// @TODO Remove this once a new version of @rollup/plugin-virtual has been released
import virtual from '@rollup/plugin-virtual';
import alias from '@rollup/plugin-alias';
import { Url } from './utils/url';
import getModuleDefault from './utils/get-module-default';
import { clone, escapeRegExp, method } from 'lodash';
import chokidar, { FSWatcher } from 'chokidar';
import { pluralize } from '@directus/shared/utils';
import { ServerResponse } from 'http';
import { BaseException } from '@directus/shared/exceptions';

let extensionManager: ExtensionManager | undefined;

export function getExtensionManager(): ExtensionManager {
	if (extensionManager) {
		return extensionManager;
	}

	extensionManager = new ExtensionManager();

	return extensionManager;
}

type EventHandler =
	| { type: 'filter'; name: string; handler: FilterHandler }
	| { type: 'action'; name: string; handler: ActionHandler }
	| { type: 'init'; name: string; handler: InitHandler }
	| { type: 'schedule'; task: ScheduledTask };

type AppExtensions = Partial<Record<AppExtensionType, string>>;
type ApiExtensions = {
	hooks: { path: string; events: EventHandler[] }[];
	endpoints: { path: string }[];
};

type Options = {
	schedule: boolean;
	watch: boolean;
};

const defaultOptions: Options = {
	schedule: true,
	watch: env.EXTENSIONS_AUTO_RELOAD && env.NODE_ENV !== 'development',
};

class ExtensionManager {
	private isLoaded = false;
	private options: Options;

	private extensions: Extension[] = [];

	private appExtensions: AppExtensions = {};
	private apiExtensions: ApiExtensions = { hooks: [], endpoints: [] };

	private apiEmitter: Emitter;
	private endpointRouter: Router;

	private watcher: FSWatcher | null = null;

	private apiDocs: { paths: any; schemas: any[] } = { paths: {}, schemas: [] };

	constructor() {
		this.options = defaultOptions;

		this.apiEmitter = new Emitter();
		this.endpointRouter = Router();
	}

	public async initialize(options: Partial<Options> = {}): Promise<void> {
		this.options = {
			...defaultOptions,
			...options,
		};

		this.initializeWatcher();

		if (!this.isLoaded) {
			await this.load();

			this.updateWatchedExtensions(this.extensions);

			const loadedExtensions = this.getExtensionsList();
			if (loadedExtensions.length > 0) {
				logger.info(`Loaded extensions: ${loadedExtensions.join(', ')}`);
			}
		}
	}

	public async reload(): Promise<void> {
		if (this.isLoaded) {
			logger.info('Reloading extensions');

			const prevExtensions = clone(this.extensions);

			this.apiDocs = { paths: {}, schemas: [] };
			await this.unload();
			await this.load();

			const added = this.extensions.filter(
				(extension) => !prevExtensions.some((prevExtension) => extension.path === prevExtension.path)
			);
			const removed = prevExtensions.filter(
				(prevExtension) => !this.extensions.some((extension) => prevExtension.path === extension.path)
			);

			this.updateWatchedExtensions(added, removed);

			const addedExtensions = added.map((extension) => extension.name);
			const removedExtensions = removed.map((extension) => extension.name);
			if (addedExtensions.length > 0) {
				logger.info(`Added extensions: ${addedExtensions.join(', ')}`);
			}
			if (removedExtensions.length > 0) {
				logger.info(`Removed extensions: ${removedExtensions.join(', ')}`);
			}
		} else {
			logger.warn('Extensions have to be loaded before they can be reloaded');
		}
	}

	public getExtensionsList(type?: ExtensionType): string[] {
		if (type === undefined) {
			return this.extensions.map((extension) => extension.name);
		} else {
			return this.extensions.filter((extension) => extension.type === type).map((extension) => extension.name);
		}
	}

	public getAppExtensions(type: AppExtensionType): string | undefined {
		return this.appExtensions[type];
	}

	public getEndpointRouter(): Router {
		return this.endpointRouter;
	}

	private async load(): Promise<void> {
		try {
			await ensureExtensionDirs(env.EXTENSIONS_PATH, env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES);

			this.extensions = await this.getExtensions();
		} catch (err: any) {
			logger.warn(`Couldn't load extensions`);
			logger.warn(err);
		}

		this.registerHooks();
		this.registerEndpoints();

		if (env.SERVE_APP) {
			this.appExtensions = await this.generateExtensionBundles();
		}

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		this.unregisterHooks();
		this.unregisterEndpoints();

		this.apiEmitter.offAll();

		if (env.SERVE_APP) {
			this.appExtensions = {};
		}

		this.isLoaded = false;
	}

	private initializeWatcher(): void {
		if (this.options.watch && !this.watcher) {
			logger.info('Watching extensions for changes...');

			const localExtensionPaths = (env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES).map((type) =>
				path.posix.join(
					path.relative('.', env.EXTENSIONS_PATH).split(path.sep).join(path.posix.sep),
					pluralize(type),
					'*',
					'index.js'
				)
			);

			this.watcher = chokidar.watch([path.resolve('.', 'package.json'), ...localExtensionPaths], {
				ignoreInitial: true,
			});

			this.watcher
				.on('add', () => this.reload())
				.on('change', () => this.reload())
				.on('unlink', () => this.reload());
		}
	}

	private updateWatchedExtensions(added: Extension[], removed: Extension[] = []): void {
		if (this.watcher) {
			const toPackageExtensionPaths = (extensions: Extension[]) =>
				extensions
					.filter((extension) => !extension.local)
					.map((extension) =>
						extension.type !== 'pack'
							? path.resolve(extension.path, extension.entrypoint || '')
							: path.resolve(extension.path, 'package.json')
					);

			const addedPackageExtensionPaths = toPackageExtensionPaths(added);
			const removedPackageExtensionPaths = toPackageExtensionPaths(removed);

			this.watcher.add(addedPackageExtensionPaths);
			this.watcher.unwatch(removedPackageExtensionPaths);
		}
	}

	private async getExtensions(): Promise<Extension[]> {
		const packageExtensions = await getPackageExtensions(
			'.',
			env.SERVE_APP ? EXTENSION_PACKAGE_TYPES : API_EXTENSION_PACKAGE_TYPES
		);
		const localExtensions = await getLocalExtensions(
			env.EXTENSIONS_PATH,
			env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES
		);

		return [...packageExtensions, ...localExtensions];
	}

	private async generateExtensionBundles() {
		const sharedDepsMapping = await this.getSharedDepsMapping(APP_SHARED_DEPS);
		const internalImports = Object.entries(sharedDepsMapping).map(([name, path]) => ({
			find: name,
			replacement: path,
		}));

		const bundles: Partial<Record<AppExtensionType, string>> = {};

		for (const extensionType of APP_EXTENSION_TYPES) {
			const entry = generateExtensionsEntry(extensionType, this.extensions);

			try {
				const bundle = await rollup({
					input: 'entry',
					external: Object.values(sharedDepsMapping),
					makeAbsoluteExternalsRelative: false,
					plugins: [virtual({ entry }), alias({ entries: internalImports })],
				});
				const { output } = await bundle.generate({ format: 'es', compact: true });

				bundles[extensionType] = output[0].code;

				await bundle.close();
			} catch (error: any) {
				logger.warn(`Couldn't bundle App extensions`);
				logger.warn(error);
			}
		}

		return bundles;
	}

	private async getSharedDepsMapping(deps: string[]) {
		const appDir = await fse.readdir(path.join(resolvePackage('@directus/app'), 'dist', 'assets'));

		const depsMapping: Record<string, string> = {};
		for (const dep of deps) {
			const depRegex = new RegExp(`${escapeRegExp(dep.replace(/\//g, '_'))}\\.[0-9a-f]{8}\\.entry\\.js`);
			const depName = appDir.find((file) => depRegex.test(file));

			if (depName) {
				const depUrl = new Url(env.PUBLIC_URL).addPath('admin', 'assets', depName);

				depsMapping[dep] = depUrl.toString({ rootRelative: true });
			} else {
				logger.warn(`Couldn't find shared extension dependency "${dep}"`);
			}
		}

		return depsMapping;
	}

	private registerHooks(): void {
		const hooks = this.extensions.filter((extension) => extension.type === 'hook');

		for (const hook of hooks) {
			try {
				this.registerHook(hook);
			} catch (error: any) {
				logger.warn(`Couldn't register hook "${hook.name}"`);
				logger.warn(error);
			}
		}
	}

	private registerEndpoints(): void {
		const endpoints = this.extensions.filter((extension) => extension.type === 'endpoint');

		for (const endpoint of endpoints) {
			try {
				this.registerEndpoint(endpoint, this.endpointRouter);
			} catch (error: any) {
				logger.warn(`Couldn't register endpoint "${endpoint.name}"`);
				logger.warn(error);
			}
		}
		const filePath = path.join(process.cwd(), '.openapi.json');
		fse.writeFile(filePath, JSON.stringify(this.apiDocs, null, 2));
	}

	private registerHook(hook: Extension) {
		const hookPath = path.resolve(hook.path, hook.entrypoint || '');
		const hookInstance: HookConfig | { default: HookConfig } = require(hookPath);

		const register = getModuleDefault(hookInstance);

		const hookHandler: { path: string; events: EventHandler[] } = {
			path: hookPath,
			events: [],
		};

		const registerFunctions = {
			filter: (event: string, handler: FilterHandler) => {
				emitter.onFilter(event, handler);

				hookHandler.events.push({
					type: 'filter',
					name: event,
					handler,
				});
			},
			action: (event: string, handler: ActionHandler) => {
				emitter.onAction(event, handler);

				hookHandler.events.push({
					type: 'action',
					name: event,
					handler,
				});
			},
			init: (event: string, handler: InitHandler) => {
				emitter.onInit(event, handler);

				hookHandler.events.push({
					type: 'init',
					name: event,
					handler,
				});
			},
			schedule: (cron: string, handler: ScheduleHandler) => {
				if (validate(cron)) {
					const task = schedule(cron, async () => {
						if (this.options.schedule) {
							try {
								await handler();
							} catch (error: any) {
								logger.error(error);
							}
						}
					});

					hookHandler.events.push({
						type: 'schedule',
						task,
					});
				} else {
					logger.warn(`Couldn't register cron hook. Provided cron is invalid: ${cron}`);
				}
			},
		};

		register(registerFunctions, {
			services,
			exceptions: { ...exceptions, ...sharedExceptions },
			env,
			database: getDatabase(),
			emitter: this.apiEmitter,
			logger: logger as any,
			getSchema,
		});

		this.apiExtensions.hooks.push(hookHandler);
	}

	private registerEndpoint(endpoint: Extension, router: Router) {
		const endpointPath = path.resolve(endpoint.path, endpoint.entrypoint || '');
		const endpointInstance: EndpointConfig | { default: EndpointConfig } = require(endpointPath);

		const prefix = Reflect.getMetadata('prefix', endpointInstance);
		const isClass = Reflect.getMetadata('isClass', endpointInstance) || false;
		const routes: Array<any> = Reflect.getMetadata('routes', endpointInstance);

		const mod = getModuleDefault(endpointInstance);
		const routeName = typeof mod === 'function' ? endpoint.name : mod.id;

		const register = typeof mod === 'function' ? mod : mod.handler;

		const scopedRouter = express.Router();
		if (isClass) {
			logger.info(`Registering class decorator endpoint "${routeName}"`);
			const instance = new (mod as any)();
			const asyncHandler = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
				Promise.resolve(fn(req, res, next)).catch(next);
			};
			/**
			 * TODO: Clearing slash
			 */

			const routePath = prefix || routeName;
			router.use(`/${routePath}`, scopedRouter);
			type IRequestMethod = 'get' | 'put' | 'post' | 'put' | 'patch' | 'delete';
			for (const route of routes) {
				const {
					requestMethod,
					path,
					methodName,
					apiDoc,
				}: { requestMethod: IRequestMethod; path: string; methodName: string; apiDoc: any } = route;
				const params = Reflect.getMetadata('param', instance, methodName) || [];
				const queries = Reflect.getMetadata('query', instance, methodName) || [];
				const bodies = Reflect.getMetadata('body', instance, methodName) || [];
				const requests = Reflect.getMetadata('request', instance, methodName) || [];
				const contexts = Reflect.getMetadata('context', instance, methodName) || [];
				const originalMethod = instance[methodName];
				// this.apiDocs.paths[`/${routePath}${swaggerPath}`] = apiDoc.paths[swaggerPath];
				scopedRouter[requestMethod](
					path,
					asyncHandler(async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
						try {
							instance[route.methodName] = (...args: any) => {
								// method decorator
								for (const param of params) {
									const { key, parameterIndex, dataType } = param;

									if (!key) {
										args[parameterIndex] = req.params;
									} else {
										const originalData = req.params[key];
										let tamperedData: any = originalData;
										if (originalData) {
											if (dataType == 'number' && typeof originalData != 'undefined') {
												try {
													tamperedData = parseFloat(originalData);
													if (isNaN(tamperedData)) tamperedData = 0;
												} catch (_e) {
													tamperedData = 0;
												}
											} else if (dataType == 'boolean' && typeof originalData != 'undefined') {
												if (originalData == 'true' || originalData == '1') tamperedData = true;
												else tamperedData = false;
											}
										}
										args[parameterIndex] = tamperedData;
									}
								}

								for (const query of queries) {
									const { key, parameterIndex, dataType } = query;

									if (!key) {
										args[parameterIndex] = req.query;
									} else {
										const originalData = req.query[key];
										let tamperedData: any = originalData;
										if (originalData) {
											if (dataType == 'number') {
												try {
													tamperedData = parseFloat(originalData.toString());
													if (isNaN(tamperedData)) tamperedData = 0;
												} catch (_e) {
													tamperedData = 0;
												}
											} else if (dataType == 'boolean') {
												if (originalData.toString().toLowerCase() == 'true' || originalData == '1') tamperedData = true;
												else tamperedData = false;
											}
										}
										args[parameterIndex] = tamperedData;
									}
								}

								for (const body of bodies) {
									const { key, parameterIndex } = body;

									if (!key) {
										args[parameterIndex] = req.body;
									} else {
										args[parameterIndex] = req.body[key];
									}
								}

								for (const request of requests) {
									const { parameterIndex } = request;
									args[parameterIndex] = req;
								}
								for (const context of contexts) {
									const { parameterIndex } = context;
									args[parameterIndex] = {
										services,
										exceptions: { ...exceptions, ...sharedExceptions },
										env,
										database: getDatabase(),
										emitter: this.apiEmitter,
										logger,
										getSchema,
									};
								}

								return originalMethod.apply(this, args);
							};
							const result = await instance[methodName](req, res, next);
							if (result instanceof ServerResponse) {
								return result;
							} else {
								return res.json(result).status(200).end();
							}
						} catch (error: any) {
							logger.error(error);
							if (error instanceof BaseException) {
								return res.status(error.status).send({
									status: false,
									message: error.toString(),
									code: error.code,
								});
							}
							return res.status(500).send({
								status: false,
								message: error.toString(),
							});
						}
					})
				);
				const paths = apiDoc.paths;
				const routePaths = Object.keys(paths);

				for (const path of routePaths) {
					let currentPath = '';
					if (route.isIndependentRoute) {
						currentPath = path;
					} else {
						currentPath = `/${routePath}${path}`;
					}
					if (typeof this.apiDocs.paths[currentPath] == 'undefined') {
						this.apiDocs.paths[currentPath] = {};
					}
					const httpMethodKeys = Object.keys(paths[path]);
					for (const httpMethod of httpMethodKeys) {
						if (typeof this.apiDocs.paths[currentPath][httpMethod] != 'undefined') {
							logger.error(
								`There are duplicate route with base route '${currentPath}' on Method [${httpMethod.toUpperCase()}] ${routePath} with tag "${
									this.apiDocs.paths[currentPath][httpMethod].tags[0]
								}"`
							);
						} else {
							const payload = paths[path][httpMethod];
							for (const query of queries) {
								const { key, dataType } = query;
								if (dataType == 'string' || dataType == 'number') {
									if (!payload.parameters) {
										payload.parameters = [
											{
												in: 'query',
												name: key,
												schema: {
													type: dataType,
												},
												required: true,
											},
										];
									} else {
										const existingQuery = payload.parameters.find(
											(x: any) => x.in == 'query' && x.name == key && x.schema.type == dataType
										);
										if (!existingQuery) {
											payload.parameters.push({
												in: 'query',
												name: key,
												schema: {
													type: dataType,
												},
												required: true,
											});
										}
									}
								}
							}
							for (const param of params) {
								const { key, dataType } = param;
								if (!payload.parameters) {
									payload.parameters = [
										{
											in: 'path',
											name: key,
											schema: {
												type: dataType,
											},
											required: true,
										},
									];
								} else {
									const existingParam = payload.parameters.find(
										(x: any) => x.in == 'path' && x.name == key && x.schema.type == dataType
									);
									if (!existingParam) {
										payload.parameters.push({
											in: 'path',
											name: key,
											schema: {
												type: dataType,
											},
											required: true,
										});
									}
								}
							}
							this.apiDocs.paths[currentPath][httpMethod] = payload;
						}
					}
					// apiDoc.paths[currentPath] = {
					//   ...apiDoc.paths[currentPath],
					//   ...paths[path]
					// };
				}
			}
			this.apiExtensions.endpoints.push({
				path: endpointPath,
			});
		} else {
			router.use(`/${routeName}`, scopedRouter);

			register(scopedRouter, {
				services,
				exceptions: { ...exceptions, ...sharedExceptions },
				env,
				database: getDatabase(),
				emitter: this.apiEmitter,
				logger: logger as any,
				getSchema,
			});

			this.apiExtensions.endpoints.push({
				path: endpointPath,
			});
		}
	}

	private unregisterHooks(): void {
		for (const hook of this.apiExtensions.hooks) {
			for (const event of hook.events) {
				switch (event.type) {
					case 'filter':
						emitter.offFilter(event.name, event.handler);
						break;
					case 'action':
						emitter.offAction(event.name, event.handler);
						break;
					case 'init':
						emitter.offInit(event.name, event.handler);
						break;
					case 'schedule':
						event.task.stop();
						break;
				}
			}

			delete require.cache[require.resolve(hook.path)];
		}

		this.apiExtensions.hooks = [];
	}

	private unregisterEndpoints(): void {
		for (const endpoint of this.apiExtensions.endpoints) {
			delete require.cache[require.resolve(endpoint.path)];
		}

		this.endpointRouter.stack = [];

		this.apiExtensions.endpoints = [];
	}
}
