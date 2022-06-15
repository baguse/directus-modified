import axios from 'axios';
import fs from 'fs';
import path from 'path';

const main = async () => {
	try {
		const pathFile = path.resolve('./uploads/23f05225-b4a4-44af-9f17-b03cba33945b.jpg');
		// console.log({pathFile})
		// console.log(process.cwd())
		const file = await fs.readFileSync(pathFile, 'base64');
		console.log(file);
		const { data } = await axios.post(
			'http://localhost:8056/files',
			{
				base64: [file],
			},
			{
				headers: {
					Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6Ijk2QkQxNzY4LTUwRUQtNDJFOC04NTA0LTA0RkEzQjlGNDIyQiIsInJvbGUiOiI4RUU4Q0ZCOS1ENjc0LTQ5OTAtOEVEQi0xM0YzRUQ2NUI1QjAiLCJhcHBfYWNjZXNzIjp0cnVlLCJhZG1pbl9hY2Nlc3MiOnRydWUsImlhdCI6MTY1NDU5NzY0NSwiZXhwIjoxNjU0NTk4NTQ1LCJpc3MiOiJkaXJlY3R1cyJ9.d1Lmhq8cjCnfl_L-fpVrikJYj7dk2aS3O91uMuDC9BY`,
				},
			}
		);
	} catch (_e) {
		console.log(_e);
	}
};

main();
