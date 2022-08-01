import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_fields', (table) => {
		table.boolean('unique_combination').defaultTo(false).notNullable();
	});
}

export async function down(knex: Knex): Promise<void> {
	await knex.schema.alterTable('directus_fields', (table) => {
		table.dropColumn('unique_combination');
	});
}
