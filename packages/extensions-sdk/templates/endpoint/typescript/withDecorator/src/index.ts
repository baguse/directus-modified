import { Body, Context, Endpoint, Get, Param, Patch, Req, Res } from "@mv-data-core/decorator";

@Endpoint()
export default class DefineEndpoint {
  @Get(
    { path: "/", tag: "Hello" },
    {
      responses: [
        {
          200: {
            description: "Description",
            responseType: "object",
            schema: {
              type: "object",
              properties: {
                msg: {
                  type: "string"
                }
              }
            },
          },
        },
      ],
    }
  )
  async hello() {
    return {
      msg: "Hello world",
    }
  }

  @Patch(
    { path: "/name/:name", tag: "Hello" },
    {
      responses: [
        {
          200: {
            description: "Description",
            responseType: "object",
            schema: {
              type: "object",
              properties: {
                msg: {
                  "type": "string"
                }
              }
            },
          },
        },
      ],
      request: {
        type: "object",
      }
    }
  )
  async update(
    @Param("name") name: string,
    @Context() context: any,
    @Body() body: any
  ) {
    const {
      exceptions: { ServiceUnavailableException },
    } = context;
    if (name == 'wrong') {
      throw new ServiceUnavailableException("Wrong name");
    }
    return {
      msg: `Hello ${name}`,
    }
  }
}
