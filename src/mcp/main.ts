import { homedir } from 'node:os'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createBridge } from './bridge'
import { mcpDiscoveryFile } from './protocol'

// Claude launches this with `node out/main/mcp.js`. stdout carries the protocol, so anything
// meant for a person goes to stderr.
createBridge(mcpDiscoveryFile(process.env, homedir()))
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    console.error('narsil-mcp could not start:', error)
    process.exit(1)
  })
