# @universal-agent/workflow-web

The prebuilt Universal Agent workflow web app — canvas editor, run trace, Chief dock — built from [`@universal-agent/workflow-ui`](../workflow-ui). [`@universal-agent/workflow-server`](../workflow-server) serves it; you normally get it through `universal-agent-workflow` and never install it directly.

```bash
npm install @universal-agent/workflow-web
```

## Serving it yourself

The package exports the directory of the built app. Serve it as static files next to the workflow HTTP API (`/api/…`), with `index.html` as the fallback for client-side routes:

```ts
import fastifyStatic from '@fastify/static';
import { webDistDir } from '@universal-agent/workflow-web';

await app.register(fastifyStatic, { root: webDistDir, wildcard: false });
app.setNotFoundHandler((request, reply) =>
  request.method === 'GET' && !request.url.startsWith('/api/') ? reply.sendFile('index.html') : reply.code(404).send({ error: 'Not found' })
);
```

The app calls the API on the same origin (`./api/…`). To build your own app instead, use the components in `@universal-agent/workflow-ui`; this package's [`src/App.tsx`](src/App.tsx) is the reference wiring.

## What's in the app

- **Design**: workflows list, canvas editing (steps, flow and parameter lines, way-back loops, containers opened in place, conditions), inspector, agents and engines, workspaces, chief settings.
- **Runs**: start with inputs and workspaces, trace timeline, live canvas, execution steps, agent conversations, step data, findings, answering questions, rerunning a step, Stop, and a chat with the Chief.

## License

MIT
