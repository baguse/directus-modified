import { BaseException } from '@directus/shared/exceptions';

type Extensions = {
	collection: string;
	field: string | string[] | null;
	invalid?: string;
};

export class RecordNotUniqueException extends BaseException {
	constructor(field: string | string[] | null, extensions?: Extensions) {
		if (field) {
			if (Array.isArray(field)) {
				super(`Combination Field "${field.join(', ')}" has to be unique.`, 400, 'RECORD_NOT_UNIQUE', extensions);
			} else {
				super(`Field "${field}" has to be unique.`, 400, 'RECORD_NOT_UNIQUE', extensions);
			}
		} else {
			super(`Field has to be unique.`, 400, 'RECORD_NOT_UNIQUE', extensions);
		}
	}
}
