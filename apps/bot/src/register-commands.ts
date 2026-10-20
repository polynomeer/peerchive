/**
 * 슬래시 명령 등록: `pnpm --filter bot register-commands`.
 * DISCORD_GUILD_ID가 있으면 그 서버에만(즉시 반영, 개발용), 없으면 전역(반영에 시간이 걸릴 수 있음).
 */
import { REST, Routes } from 'discord.js'
import { COMMAND_DEFINITIONS } from './commands'
import { loadRootEnv } from './env'

loadRootEnv()
const token = process.env.DISCORD_BOT_TOKEN?.trim()
const applicationId = process.env.DISCORD_APPLICATION_ID?.trim()
const guildId = process.env.DISCORD_GUILD_ID?.trim()
if (!token || !applicationId) throw new Error('DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required')

const rest = new REST({ version: '10' }).setToken(token)
const route = guildId ? Routes.applicationGuildCommands(applicationId, guildId) : Routes.applicationCommands(applicationId)
await rest.put(route, { body: COMMAND_DEFINITIONS })
console.info(`[bot] registered ${COMMAND_DEFINITIONS.length} commands (${guildId ? `guild ${guildId}` : 'global'})`)
