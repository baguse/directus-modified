import Bull from 'bull';
import env from '../env';

export class BullService {
	private queue: Bull.Queue;
	constructor(queueName: string, opts?: Bull.QueueOptions) {
		let options: Bull.QueueOptions | undefined = opts;
		if (!opts) {
			options = {
				redis: {
					host: env.REDIST_HOST,
					port: env.REDIST_PORT,
					username: env.REDIST_USERNAME,
					password: env.REDIST_PASSWORD,
				},
			};
		}
		this.queue = new Bull(queueName, options);
	}

	public getQueue() {
		return this.queue;
	}
}
