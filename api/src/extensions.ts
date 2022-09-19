import express, { NextFunction, Router, Response as ExpressResponse, Request as ExpressRequest } from 'express';
import path from 'path';
import 'reflect-metadata';
import {
	ActionHandler,
	ApiExtension,
	AppExtensionType,
	EndpointConfig,
	Extension,
	ExtensionType,
	FilterHandler,
	HookConfig,
	HybridExtension,
	InitHandler,
	OperationApiConfig,
	ScheduleHandler,
} from '@directus/shared/types';
import {
	ensureExtensionDirs,
	generateExtensionsEntry,
	getLocalExtensions,
	getPackageExtensions,
} from '@directus/shared/utils/node';
import {
	API_EXTENSION_PACKAGE_TYPES,
	API_EXTENSION_TYPES,
	APP_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	EXTENSION_PACKAGE_TYPES,
	EXTENSION_TYPES,
	HYBRID_EXTENSION_TYPES,
	PACK_EXTENSION_TYPE,
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
import { schedule, validate } from 'node-cron';
import { rollup } from 'rollup';
import virtual from '@rollup/plugin-virtual';
import alias from '@rollup/plugin-alias';
import { Url } from './utils/url';
import getModuleDefault from './utils/get-module-default';
import { clone, escapeRegExp } from 'lodash';
import chokidar, { FSWatcher } from 'chokidar';
import { isExtensionObject, isHybridExtension, pluralize } from '@directus/shared/utils';
import { getFlowManager } from './flows';
import globby from 'globby';
import { EventHandler } from './types';
import { JobQueue } from './utils/job-queue';
import { ServerResponse } from 'http';
import { BaseException } from '@directus/shared/exceptions';
import { Server } from 'socket.io';
import isDirectusJWT from './utils/is-directus-jwt';
import { verifyAccessJWT } from './utils/jwt';
import { InvalidCredentialsException, TokenExpiredException } from './exceptions';
import Busboy from 'busboy';

let extensionManager: ExtensionManager | undefined;

export function getExtensionManager(): ExtensionManager {
	if (extensionManager) {
		return extensionManager;
	}

	extensionManager = new ExtensionManager();

	return extensionManager;
}

type AppExtensions = Partial<Record<AppExtensionType, string>>;
type ApiExtensions = {
	hooks: { path: string; events: EventHandler[] }[];
	endpoints: { path: string }[];
	operations: { path: string }[];
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
	private apiExtensions: ApiExtensions = { hooks: [], endpoints: [], operations: [] };

	private apiEmitter: Emitter;
	private endpointRouter: Router;

	private reloadQueue: JobQueue;
	private watcher: FSWatcher | null = null;

	private apiDocs: { paths: any; schemas: any[] } = { paths: {}, schemas: [] };

	private socket?: Server;

	constructor() {
		this.options = defaultOptions;

		this.apiEmitter = new Emitter();
		this.endpointRouter = Router();

		this.reloadQueue = new JobQueue();
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

	public reload(): void {
		this.reloadQueue.enqueue(async () => {
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
		});
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
		await this.registerOperations();

		if (env.SERVE_APP) {
			this.appExtensions = await this.generateExtensionBundles();
		}

		this.isLoaded = true;
	}

	private async unload(): Promise<void> {
		this.unregisterHooks();
		this.unregisterEndpoints();
		this.unregisterOperations();

		this.apiEmitter.offAll();

		if (env.SERVE_APP) {
			this.appExtensions = {};
		}

		this.isLoaded = false;
	}

	private initializeWatcher(): void {
		if (this.options.watch && !this.watcher) {
			logger.info('Watching extensions for changes...');

			const localExtensionPaths = (env.SERVE_APP ? EXTENSION_TYPES : API_EXTENSION_TYPES).flatMap((type) => {
				const typeDir = path.posix.join(
					path.relative('.', env.EXTENSIONS_PATH).split(path.sep).join(path.posix.sep),
					pluralize(type)
				);

				return isHybridExtension(type)
					? [path.posix.join(typeDir, '*', 'app.js'), path.posix.join(typeDir, '*', 'api.js')]
					: path.posix.join(typeDir, '*', 'index.js');
			});

			this.watcher = chokidar.watch([path.resolve('package.json'), ...localExtensionPaths], {
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
					.flatMap((extension) =>
						extension.type === PACK_EXTENSION_TYPE
							? path.resolve(extension.path, 'package.json')
							: isExtensionObject(extension, HYBRID_EXTENSION_TYPES)
							? [
									path.resolve(extension.path, extension.entrypoint.app),
									path.resolve(extension.path, extension.entrypoint.api),
							  ]
							: path.resolve(extension.path, extension.entrypoint)
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
		const adminPath = require.resolve('@directus/app');
		const appDir = await fse.readdir(path.join(`${adminPath}`, '..', 'assets'));

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
		const hooks = this.extensions.filter((extension): extension is ApiExtension => extension.type === 'hook');

		for (const hook of hooks) {
			try {
				const hookPath = path.resolve(hook.path, hook.entrypoint);
				const hookInstance: HookConfig | { default: HookConfig } = require(hookPath);

				const config = getModuleDefault(hookInstance);

				this.registerHook(config, hookPath);
			} catch (error: any) {
				logger.warn(`Couldn't register hook "${hook.name}"`);
				logger.warn(error);
			}
		}
	}

	private registerEndpoints(): void {
		const endpoints = this.extensions.filter((extension): extension is ApiExtension => extension.type === 'endpoint');

		for (const endpoint of endpoints) {
			try {
				const endpointPath = path.resolve(endpoint.path, endpoint.entrypoint);
				const endpointInstance: EndpointConfig | { default: EndpointConfig } = require(endpointPath);

				const config = getModuleDefault(endpointInstance);

				this.registerEndpoint(config, endpointPath, endpoint.name, this.endpointRouter);
			} catch (error: any) {
				logger.warn(`Couldn't register endpoint "${endpoint.name}"`);
				logger.warn(error);
			}
		}
		const filePath = path.join(process.cwd(), '.openapi.json');
		fse.writeFile(filePath, JSON.stringify(this.apiDocs, null, 2));
	}

	private async registerOperations(): Promise<void> {
		const internalPaths = await globby(
			path.posix.join(path.relative('.', __dirname).split(path.sep).join(path.posix.sep), 'operations/*/index.(js|ts)')
		);

		const internalOperations = internalPaths.map((internalPath) => {
			const dirs = internalPath.split(path.sep);

			return {
				name: dirs[dirs.length - 2],
				path: dirs.slice(0, -1).join(path.sep),
				entrypoint: { api: dirs[dirs.length - 1] },
			};
		});

		const operations = this.extensions.filter(
			(extension): extension is HybridExtension => extension.type === 'operation'
		);

		for (const operation of [...internalOperations, ...operations]) {
			try {
				const operationPath = path.resolve(operation.path, operation.entrypoint.api);
				const operationInstance: OperationApiConfig | { default: OperationApiConfig } = require(operationPath);

				const config = getModuleDefault(operationInstance);

				this.registerOperation(config, operationPath);
			} catch (error: any) {
				logger.warn(`Couldn't register operation "${operation.name}"`);
				logger.warn(error);
			}
		}
	}

	private registerHook(register: HookConfig, path: string) {
		const hookHandler: { path: string; events: EventHandler[] } = {
			path,
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
			socket: this.socket,
		});

		this.apiExtensions.hooks.push(hookHandler);
	}

	private registerEndpoint(config: EndpointConfig, path: string, name: string, router: Router) {
		const register = typeof config === 'function' ? config : config.handler;
		const routeName = typeof config === 'function' ? name : config.id;
		const endpointInstance: any = require(path);

		const prefix = Reflect.getMetadata('prefix', endpointInstance);
		const isClass = Reflect.getMetadata('isClass', endpointInstance) || false;
		const routes: Array<any> = Reflect.getMetadata('routes', endpointInstance);

		const scopedRouter = express.Router();
		if (isClass) {
			logger.info(`Registering class decorator endpoint "${routeName}"`);
			const instance = new endpointInstance();
			const asyncHandler = (fn: any) => (req: Request, res: Response, next: NextFunction) => {
				Promise.resolve(fn(req, res, next)).catch(next);
			};
			const clearingSlash = (str: string) => {
				let result = str;
				if (result.startsWith('/')) {
					result = result.slice(1);
				}
				if (result.endsWith('/')) {
					result = result.slice(0, -1);
				}
				return result;
			};

			const routePath = prefix || routeName;
			router.use(`/${clearingSlash(routePath)}`, scopedRouter);
			type IRequestMethod = 'get' | 'put' | 'post' | 'put' | 'patch' | 'delete';

			interface _ExpressRequest extends ExpressRequest {
				busboy?: Busboy.Busboy;
			}

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
				const responses = Reflect.getMetadata('response', instance, methodName) || [];
				const contexts = Reflect.getMetadata('context', instance, methodName) || [];
				const originalMethod = instance[methodName];
				// this.apiDocs.paths[`/${routePath}${swaggerPath}`] = apiDoc.paths[swaggerPath];
				scopedRouter[requestMethod](
					path,
					asyncHandler(async (req: _ExpressRequest, res: ExpressResponse, next: NextFunction) => {
						try {
							if (req.is('multipart/form-data')) {
								let headers: Busboy.BusboyHeaders;

								if (req.headers['content-type']) {
									headers = req.headers as Busboy.BusboyHeaders;
								} else {
									headers = {
										...req.headers,
										'content-type': 'application/octet-stream',
									};
								}

								const busboy = new Busboy({ headers });

								req.busboy = busboy;
							}
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

								for (const response of responses) {
									const { parameterIndex } = response;
									args[parameterIndex] = res;
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
										socket: this.socket,
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
				}
			}
			this.apiExtensions.endpoints.push({
				path: path,
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
				socket: this.socket,
			});
		}

		this.apiExtensions.endpoints.push({
			path,
		});
	}

	private registerOperation(config: OperationApiConfig, path: string) {
		const flowManager = getFlowManager();

		flowManager.addOperation(config.id, config.handler);

		this.apiExtensions.operations.push({
			path,
		});
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

	private unregisterOperations(): void {
		for (const operation of this.apiExtensions.operations) {
			delete require.cache[require.resolve(operation.path)];
		}

		const flowManager = getFlowManager();

		flowManager.clearOperations();

		this.apiExtensions.operations = [];
	}

	public registerWebsockets(socketServer: Server): void {
		this.socket = socketServer;

		this.socket.use(async (socket, next) => {
			const authHeader = socket.handshake.headers.authorization;

			if (authHeader) {
				const token = authHeader.split(' ')[1];
				if (isDirectusJWT(token)) {
					try {
						const payload = verifyAccessJWT(token, env.SECRET);
						socket.data.accountability = {
							share: payload.share,
							share_scope: payload.share_scope,
							user: payload.id,
							role: payload.role,
							admin: payload.admin_access === true || payload.admin_access == 1,
							app: payload.app_access === true || payload.app_access == 1,
						};
					} catch (e) {
						next(new TokenExpiredException('Token expired.'));
					}
				} else {
					// Try finding the user with the provided token
					const database = getDatabase();
					const user = await database
						.select(
							'directus_users.id',
							'directus_users.role',
							'directus_roles.admin_access',
							'directus_roles.app_access'
						)
						.from('directus_users')
						.leftJoin('directus_roles', 'directus_users.role', 'directus_roles.id')
						.where({
							'directus_users.token': token,
							status: 'active',
						})
						.first();

					if (!user) {
						next(new InvalidCredentialsException());
					}

					socket.data.accountability = {
						user: user.id,
						role: user.role,
						admin: user.admin_access === true || user.admin_access == 1,
						app: user.app_access === true || user.app_access == 1,
					};
				}
			}

			next();
		});

		this.socket.on('connection', (socket) => {
			logger.info(`Client [${(socket.client as any).id}] connected`);
			socket.on('disconnect', function () {
				logger.info(`Client [${(socket.client as any).id}] disconnected`);
			});

			const extensionPath = env.EXTENSIONS_PATH;
			const websocketPath = path.resolve(path.join(extensionPath, 'websockets'));

			if (fse.pathExistsSync(websocketPath)) {
				for (const websocketFileExtension of fse.readdirSync(websocketPath)) {
					const websocketFileExtensionPath = path.resolve(path.join(websocketPath, websocketFileExtension));
					try {
						const websocketInstance = require(websocketFileExtensionPath);
						websocketInstance({
							socketServer: this.socket,
							socket,
							services,
							exceptions: { ...exceptions, ...sharedExceptions },
							env,
							database: getDatabase(),
							emitter: this.apiEmitter,
							logger: logger as any,
							getSchema,
						});
						logger.info(`Extension webSocket [${websocketFileExtension}] loaded`);
					} catch (e: any) {
						logger.error(`Extension webSocket [${websocketFileExtension}] failed to load`);
					}
				}
			}
		});
	}
}
