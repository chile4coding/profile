declare module 'supertest' {
  import { http, Server } from 'node:http';
  interface SuperTest<T = import('node:http').Server> {
    (server: T): supertest.Test;
  }
  namespace supertest {
    interface Test {
      get(path: string): TestAgent;
      post(path: string): TestAgent;
      put(path: string): TestAgent;
      patch(path: string): TestAgent;
      delete(path: string): TestAgent;
      head(path: string): TestAgent;
      options(path: string): TestAgent;
      send(body: object): Test;
      set(field: string, value?: string | string[]): Test;
      query(params: object): Test;
      attach(field: string, content: Buffer | Stream, filename?: string): Test;
      expect(fn: (res: Response) => boolean): Test;
      expect(status: number): Test;
      expect(prop: string, val: any): Test;
      end(callback: (err: Error | null, res: Response) => void): Test;
    }
    interface TestAgent {
      get(path: string): Test;
      post(path: string): Test;
      put(path: string): Test;
      patch(path: string): Test;
      delete(path: string): Test;
      head(path: string): Test;
      options(path: string): Test;
    }
    interface Response extends http.IncomingMessage {
      body: any;
      status: number;
      statusCode: number;
      headers: Record<string, string | string[] | undefined>;
      text: string;
    }
  }
  const supertest: supertest.Test & {
    agent: (server: Server) => TestAgent;
    request: (server: Server) => Test;
  };
  export = supertest;
}