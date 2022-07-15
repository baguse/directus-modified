import axios from 'axios';
import fs from 'fs';
import path from 'path';

const main = async () => {
	try {
		const pathFile = path.resolve('./uploads/tmpfile');
		// console.log({pathFile})
		// console.log(process.cwd())
		const file = await fs.readFileSync(pathFile, 'base64');
		const {
			data: { data: loginData },
		} = await axios.post('http://localhost:8056/auth/login', {
			email: 'andreanto.bagus@gmail.com',
			password: 'indonesiaraya',
		});
		const { data } = await axios.post(
			'http://localhost:8056/files',
			[
				{
					base64: file,
					fileName: 'tesss_28062022.pdf',
				},
				{
					base64: file,
				},
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
