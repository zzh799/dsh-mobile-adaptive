/**
 * dsh-mobile-adaptive, node half: mounts the upload RPC channel (PRD 3.4) on the
 * generic connection transport. The channel registration is the ONLY host
 * behavior — the browser half owns the whole mobile surface. All
 * @deepseek-ai references below are type-only (erased at build), so this
 * bundle's only runtime imports are node builtins and the host Loader needs
 * no extra node_modules.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUploadChannel } from './upload-host.ts'

export { UPLOAD_DIR, createUploadChannel, fullyQualified } from './upload-host.ts'

/** Cordis plugin name. */
export const name = 'dsh-mobile-adaptive'

/** Required services: the generic RPC registry (client-connection's Host half). */
export const inject = ['connection'] as const

/**
 * Mount the upload channel. The route lives on the webserver under
 * `/dsh-mobile-adaptive/<endpoint>` with the connection transport's own trust fence
 * (DNS-rebinding + cross-site defense over the deployment's trustedHosts).
 * @param ctx - host context.
 */
export function apply(ctx: Context): void {
  const channel = createUploadChannel()
  const remove = ctx.connection.rpc.handle('/dsh-mobile-adaptive', channel.handler, { authority: 'trusted-host' })
  ctx.effect(() => () => {
    channel.dispose()
    void remove()
  }, 'dsh-mobile-adaptive: upload channel')
}
