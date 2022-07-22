import express from 'express';
import { ForbiddenException, RouteNotFoundException } from '../exceptions';
import collectionExists from '../middleware/collection-exists';
import { respond } from '../middleware/respond';
import { validateBatch } from '../middleware/validate-batch';
import { ItemsService, MetaService } from '../services';
import { PrimaryKey } from '../types';
import asyncHandler from '../utils/async-handler';

const router = express.Router();

router.post(
	'/:collection',
	collectionExists,
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		if (req.singleton) {
			throw new RouteNotFoundException(req.path);
		}

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		const savedKeys: PrimaryKey[] = [];

		if (Array.isArray(req.body)) {
			const keys = await service.createMany(req.body);
			savedKeys.push(...keys);
		} else {
			const key = await service.createOne(req.body);
			savedKeys.push(key);
		}

		try {
			if (Array.isArray(req.body)) {
				const result = await service.readMany(savedKeys, req.sanitizedQuery);
				res.locals.payload = { data: result || null };
			} else {
				const result = await service.readOne(savedKeys[0], req.sanitizedQuery);
				res.locals.payload = { data: result || null };
			}
		} catch (error: any) {
			if (error instanceof ForbiddenException) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond
);

const readHandler = asyncHandler(async (req, res, next) => {
	if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

	const service = new ItemsService(req.collection, {
		accountability: req.accountability,
		schema: req.schema,
		options: {
			bearerToken: req.headers.authorization,
		},
	});

	const metaService = new MetaService({
		accountability: req.accountability,
		schema: req.schema,
	});

	let result;

	if (req.singleton) {
		result = await service.readSingleton(req.sanitizedQuery);
	} else if (req.body.keys) {
		result = await service.readMany(req.body.keys, req.sanitizedQuery);
	} else {
		result = await service.readByQuery(req.sanitizedQuery);
	}

	const meta = await metaService.getMetaForQuery(req.collection, req.sanitizedQuery);

	res.locals.payload = {
		meta: meta,
		data: result,
	};

	return next();
});

router.search('/:collection', collectionExists, validateBatch('read'), readHandler, respond);
router.get('/:collection', collectionExists, readHandler, respond);

router.get(
	'/:collection/:pk',
	collectionExists,
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		const result = await service.readOne(req.params.pk, req.sanitizedQuery);

		res.locals.payload = {
			data: result || null,
		};

		return next();
	}),
	respond
);

router.patch(
	'/:collection',
	collectionExists,
	validateBatch('update'),
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		if (req.singleton === true) {
			await service.upsertSingleton(req.body);
			const item = await service.readSingleton(req.sanitizedQuery);

			res.locals.payload = { data: item || null };
			return next();
		}

		let keys: PrimaryKey[] = [];

		if (Array.isArray(req.body)) {
			for (const body of req.body) {
				if (body.keys) {
					const currentKeys = await service.updateMany(body.keys, body.data);
					keys = [...keys, ...currentKeys];
				} else {
					const currentKeys = await service.updateByQuery(body.query, body.data);
					keys = [...keys, ...currentKeys];
				}
			}
		} else {
			if (req.body.keys) {
				keys = await service.updateMany(req.body.keys, req.body.data);
			} else {
				keys = await service.updateByQuery(req.body.query, req.body.data);
			}
		}

		try {
			const result = await service.readMany(keys, req.sanitizedQuery);
			res.locals.payload = { data: result };
		} catch (error: any) {
			if (error instanceof ForbiddenException) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond
);

router.patch(
	'/:collection/:pk',
	collectionExists,
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		if (req.singleton) {
			throw new RouteNotFoundException(req.path);
		}

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		const updatedPrimaryKey = await service.updateOne(req.params.pk, req.body);

		try {
			const result = await service.readOne(updatedPrimaryKey, req.sanitizedQuery);
			res.locals.payload = { data: result || null };
		} catch (error: any) {
			if (error instanceof ForbiddenException) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond
);

router.patch(
	'/:collection/:pk/restore',
	collectionExists,
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		if (req.singleton) {
			throw new RouteNotFoundException(req.path);
		}

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		const [restoredPrimaryKey] = await service.restore([req.params.pk], req.body);

		try {
			const result = await service.readOne(restoredPrimaryKey, req.sanitizedQuery);
			res.locals.payload = { data: result || null };
		} catch (error: any) {
			if (error instanceof ForbiddenException) {
				return next();
			}

			throw error;
		}

		return next();
	}),
	respond
);

router.delete(
	'/:collection',
	collectionExists,
	validateBatch('delete'),
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		if (Array.isArray(req.body)) {
			await service.deleteMany(req.body, {
				deleteds: req.sanitizedQuery.deleteds,
				forceDelete: req.sanitizedQuery.forceDelete,
			});
		} else if (req.body.keys) {
			await service.deleteMany(req.body.keys, {
				deleteds: req.sanitizedQuery.deleteds,
				forceDelete: req.sanitizedQuery.forceDelete,
			});
		} else {
			await service.deleteByQuery(req.body.query, {
				deleteds: req.sanitizedQuery.deleteds,
				forceDelete: req.sanitizedQuery.forceDelete,
			});
		}

		return next();
	}),
	respond
);

router.delete(
	'/:collection/:pk',
	collectionExists,
	asyncHandler(async (req, res, next) => {
		if (req.params.collection.startsWith('directus_')) throw new ForbiddenException();

		const service = new ItemsService(req.collection, {
			accountability: req.accountability,
			schema: req.schema,
			options: {
				bearerToken: req.headers.authorization,
			},
		});

		await service.deleteOne(req.params.pk, {
			deleteds: req.sanitizedQuery.deleteds,
			forceDelete: req.sanitizedQuery.forceDelete,
		});
		return next();
	}),
	respond
);

export default router;
