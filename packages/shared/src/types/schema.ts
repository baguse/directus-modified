import { Type } from './fields';
import { Relation } from './relations';
import { Filter } from './filter';

export type FieldOverview = {
	field: string;
	defaultValue: any;
	nullable: boolean;
	generated: boolean;
	type: Type | 'unknown' | 'alias';
	dbType: string | null;
	precision: number | null;
	scale: number | null;
	special: string[];
	note: string | null;
	validation: Filter | null;
	alias: boolean;
};

export type CollectionsOverview = {
	[name: string]: {
		collection: string;
		primary: string;
		singleton: boolean;
		sortField: string | null;
		note: string | null;
		accountability: 'all' | 'activity' | null;
		isSoftDelete: boolean;
		schema: string;
		fields: {
			[name: string]: FieldOverview;
		};
		depends_on: string[] | undefined;
	};
};

export type SchemaOverview = {
	collections: CollectionsOverview;
	relations: Relation[];
	relationMap: {
		[collectionName: string]: Relation[];
	};
};
