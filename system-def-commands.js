/**
 * system-def-commands.js — slash-command entry points for the generic
 * System Definition (Modern) mode.
 *
 * `/sysdef default` — enable Modern mode on the current chat using the built-in
 *                     "Awakened World" foundation (the zero-setup Quick Start).
 * `/sysdef status`  — report the current chat's mode + committed foundation.
 *
 * This is the minimal reachable path to Modern mode without the (not-yet-ported)
 * Foundation Builder wizard. Everything it does is per-chat and additive; D&D
 * chats are untouched. The foundation layer is imported lazily so a plain D&D
 * session that never runs the command doesn't parse it.
 */

import { getCampaignMode, saveChatState } from './state-manager.js';

export function registerSystemDefCommands() {
    const ctx = SillyTavern.getContext();
    const { SlashCommand, SlashCommandParser, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
    if (!SlashCommand || !SlashCommandParser || typeof SlashCommandParser.addCommandObject !== 'function') return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sysdef',
        helpString: 'Generic System Definition mode. "/sysdef build" opens the Foundation Builder wizard; "/sysdef default" enables Modern mode with the built-in Awakened World foundation; "/sysdef tree" opens the Skill Tree; "/sysdef status" shows the current mode.',
        unnamedArgumentList: SlashCommandArgument
            ? [SlashCommandArgument.fromProps({ description: 'build | default | tree | status', typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined, isRequired: false })]
            : [],
        callback: async (_args, value) => {
            // Read a FRESH context each invocation — the `ctx` captured at
            // registration is a snapshot from init time (no chat loaded yet), so
            // its chatId is stale. Fall back to the live current-chat helper.
            const chatId = (SillyTavern.getContext().chatId
                || (typeof globalThis._rpgCurrentChatId === 'function' ? globalThis._rpgCurrentChatId() : ''))
                || '';
            if (!chatId) { toastr['warning']('Open a chat first.', 'System Definition'); return ''; }
            const sub = String(value || 'status').trim().toLowerCase();

            if (sub === 'build') {
                const { openFoundationWizard } = await import('./foundation-wizard.js');
                openFoundationWizard();
                return '';
            }

            if (sub === 'tree') {
                const { openSkillTreeTab } = await import('./skilltree-bridge.js');
                openSkillTreeTab();
                return '';
            }

            if (sub === 'status') {
                const { getFoundation } = await import('./foundation.js');
                const mode = getCampaignMode(chatId);
                const f = getFoundation(chatId);
                toastr['info'](`Mode: ${mode}${f ? ` — ${f.SETTING?.name || 'campaign'} (foundation v${f.foundationVersion})` : ''}`, 'System Definition');
                return mode;
            }

            if (sub === 'default') {
                if (getCampaignMode(chatId) === 'modern') {
                    toastr['info']('This chat is already in Modern mode.', 'System Definition');
                    return 'modern';
                }
                const { validateFoundation, commitFoundationAndInit } = await import('./foundation.js');
                const { defaultFoundation } = await import('./default-foundation.js');
                const foundation = defaultFoundation();
                const v = validateFoundation(foundation);
                if (!v.ok) {
                    toastr['error']('Default foundation failed validation: ' + v.errors.join('; '), 'System Definition');
                    return '';
                }
                await commitFoundationAndInit(chatId, foundation);
                saveChatState(chatId);
                toastr['success']('Modern mode enabled (Awakened World). Send a message or re-apply the sysprompt to activate.', 'System Definition');
                return 'modern';
            }

            toastr['warning']('Usage: /sysdef default | status', 'System Definition');
            return '';
        },
    }));
}
