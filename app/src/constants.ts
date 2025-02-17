import { SettingsModuleBarLink, SettingsModuleBarModule, Type } from '@directus/shared/types';

export const VALIDATION_TYPES = ['FAILED_VALIDATION', 'RECORD_NOT_UNIQUE', 'RECORD_NOT_UNIQUE_COMBINATION'];

export const DIRECTUS_LOGO = `
                         @                        
                    %@@@@@@@@@                    
                @@@@@@@@@@@@@@@@@@/               
             @@@@@@@@@@@@@@@@@@@@@@@@             
       #@@#  @@@@@@@@@@@/ @@@@@@@@@@@@  @@@.      
   @@@@@@@#  @@@@@@@@        ,@@@@@@@@  @@@@@@@/  
@@@@@@@@@#  @@@(                 @@@@  @@@@@@@@@@
@@@@@@@@@@#                             @@@@@@@@@@
@@@@@@@@@@#                             @@@@@@@@@@
@@@@@@@@@@@@&                         @@@@@@@@@@@@
@@@@@@@@@@@@@@@@@                %@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@@@@@@(       @@@@@@@@@@@@@@@@@@@@@
@@@@@@@@@@@@@@@@@@@@@@@@% @@@@@@@@@@@@@@@@@@@@@@@@
@@@@@@@@@@# @@@@@@@@@@@@@@@@@@@@@@@@@@  @@@@@@@@@@
@@@@@@@@@@#     .@@@@@@@@@@@@@@@@@      @@@@@@@@@@
@@@@@@@@@@           @@@@@@@@&          /@@@@@@@@@
@@@@@@@&                                   @@@@@@@
@@@#                                           @@@
       #@@@@@@@@@                /@@@@@@@@@,      
   /@@@@@@@@@@@@@@@@@/       @@@@@@@@@@@@@@@@@@   
       .@@@@@@@@@@@@@@@@& @@@@@@@@@@@@@@@@(       
            %@@@@@@@@@@@@@@@@@@@@@@@@@,           
                ,@@@@@@@@@@@@@@@@@                
                     @@@@@@@@#                    
`;

/**
 * These are the system endpoints that don't have full/regular CRUD operations available.
 */
export const COLLECTIONS_DENY_LIST = [
	'directus_activity',
	'directus_collections',
	'directus_fields',
	'directus_migrations',
	'directus_relations',
	'directus_revisions',
	'directus_sessions',
	'directus_settings',
];

export const MODULE_BAR_DEFAULT: (SettingsModuleBarLink | SettingsModuleBarModule)[] = [
	{
		type: 'module',
		id: 'content',
		enabled: true,
	},
	{
		type: 'module',
		id: 'users',
		enabled: true,
	},
	{
		type: 'module',
		id: 'files',
		enabled: true,
	},
	{
		type: 'module',
		id: 'insights',
		enabled: true,
	},
	{
		type: 'module',
		id: 'docs',
		enabled: true,
	},
	{
		type: 'module',
		id: 'erd-viewer',
		enabled: false,
	},
	{
		type: 'module',
		id: 'fields-builder',
		enabled: false,
	},
	{
		type: 'module',
		id: 'settings',
		enabled: true,
		locked: true,
	},
];

export const FIELD_TYPES_SELECT: Array<{ value: Type; text: string } | { divider: true }> = [
	{
		text: '$t:string',
		value: 'string',
	},
	{
		text: '$t:text',
		value: 'text',
	},
	{ divider: true },
	{
		text: '$t:boolean',
		value: 'boolean',
	},
	{ divider: true },
	{
		text: '$t:integer',
		value: 'integer',
	},
	{
		text: '$t:bigInteger',
		value: 'bigInteger',
	},
	{
		text: '$t:float',
		value: 'float',
	},
	{
		text: '$t:decimal',
		value: 'decimal',
	},
	{ divider: true },
	{
		text: '$t:geometry',
		value: 'geometry',
	},
	{ divider: true },
	{
		text: '$t:timestamp',
		value: 'timestamp',
	},
	{
		text: '$t:datetime',
		value: 'dateTime',
	},
	{
		text: '$t:date',
		value: 'date',
	},
	{
		text: '$t:time',
		value: 'time',
	},
	{ divider: true },
	{
		text: '$t:json',
		value: 'json',
	},
	{
		text: '$t:csv',
		value: 'csv',
	},
	{
		text: '$t:uuid',
		value: 'uuid',
	},
	{
		text: '$t:hash',
		value: 'hash',
	},
];

export const DEFAULT_AUTH_PROVIDER = 'default';

export const AUTH_SSO_DRIVERS = ['oauth2', 'openid'];
