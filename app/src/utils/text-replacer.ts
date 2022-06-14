export const urlReplacer = (collectionName: string) => {
	return collectionName.replace('directus_', 'mv_datacore_');
};

export const urlRevertReplacer = (collectionName: string) => {
	return collectionName.replace('mv_datacore_', 'directus_');
};

export const nameReplacer = (name: string) => {
	return name.replace('Directus ', 'MV Datacore ');
};
