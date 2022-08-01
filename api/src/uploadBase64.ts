import axios from 'axios';
import fs from 'fs';
import path from 'path';

const main = async () => {
	try {
		const pathFile = path.resolve('./a.png');
		// console.log({pathFile})
		// console.log(process.cwd())
		const api = 'https://datcore.lanius.tech';
		const file = await fs.readFileSync(pathFile, 'base64');
		// console.log({
		// 	file,
		// });
		const {
			data: { data: loginData },
		} = await axios.post(`${api}/auth/login`, {
			email: 'andreanto.bagus@gmail.com',
			password: 'indonesiaraya',
		});
		// console.log
		const { data } = await axios.post(
			`${api}/files`,
			[
				{
					base64: file,
					fileName: 'cobak.png',
				},
				// {
				// 	base64: file,
				// },
			],
			{
				headers: {
					Authorization: `Bearer ${loginData.access_token}`,
					'Upload-Type': 'base64',
				},
			}
		);
		// console.log(data.data);
	} catch (_e: any) {
		// console.log(_e.response?.data);
	}
	process.exit();
};

main();
