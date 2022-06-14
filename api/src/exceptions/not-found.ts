import { BaseException } from '@directus/shared/exceptions';

type Extensions = {
	allow: string[];
};

export class NotFoundException extends BaseException {
	constructor(message = 'Not Found.', extensions: Extensions) {
		super(message, 404, 'NOT_FOUND', extensions);
	}
}
