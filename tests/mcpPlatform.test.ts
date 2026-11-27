import { describe, expect, it } from 'vitest'
import { mcpDiscoveryFile, mcpEndpoint } from '../src/mcp/protocol'

const ID = '0123456789abcdef0123456789abcdef'

describe('where Narsil tells the bridge how to reach it', () => {
  it('uses Local AppData on Windows, as before', () => {
    expect(mcpDiscoveryFile({ LOCALAPPDATA: 'C:\\Users\\ana\\AppData\\Local' }, 'C:\\Users\\ana', 'win32')).toBe(
      'C:\\Users\\ana\\AppData\\Local\\Narsil\\mcp.json'
    )
  })

  it('uses Application Support on a Mac', () => {
    expect(mcpDiscoveryFile({}, '/Users/ana', 'darwin')).toBe('/Users/ana/Library/Application Support/Narsil/mcp.json')
  })

  it('uses the XDG state folder on Linux, or ~/.local/state without it', () => {
    expect(mcpDiscoveryFile({ XDG_STATE_HOME: '/home/ana/state' }, '/home/ana', 'linux')).toBe('/home/ana/state/narsil/mcp.json')
    expect(mcpDiscoveryFile({}, '/home/ana', 'linux')).toBe('/home/ana/.local/state/narsil/mcp.json')
  })
})

describe('the endpoint the bridge connects to', () => {
  it('is a named pipe on Windows', () => {
    expect(mcpEndpoint('win32', 'C:\\Users\\ana\\AppData\\Local\\Narsil', ID)).toBe(`\\\\.\\pipe\\narsil-mcp-${ID}`)
  })

  it('is a Unix socket next to the discovery file on a Mac, short enough for macOS', () => {
    const dir = '/Users/ana/Library/Application Support/Narsil'
    const socket = mcpEndpoint('darwin', dir, ID)
    expect(socket).toBe(`${dir}/mcp-01234567.sock`)
    // macOS refuses socket paths longer than 104 bytes; leave room for long user names.
    expect(Buffer.byteLength(socket)).toBeLessThan(80)
  })
})
