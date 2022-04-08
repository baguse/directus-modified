import env from '../env';
import Redis from 'ioredis';
import logger from '../logger';

export class RedisService {
	private host = '';
	private port = 6379;
	private password;
	private username;
	constructor() {
		this.port = env.REDIS_PORT || 6379;
		this.host = env.REDIS_HOST;
		this.password = env.REDIS_PASS;
		this.username = env.REDIST_USERNAME;
	}

	async getClient() {
		const client = new Redis({
			host: this.host,
			port: this.port,
			password: this.password,
			username: this.username,
		});

		client.on('error', (err: any) => logger.log('Redis Client Error', err));

		return client;
	}
}
