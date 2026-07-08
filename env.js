/**
 * env.js — extension environment constants.
 *
 * FOLDER_NAME is this extension's directory name under third-party/, derived
 * from the module URL so it stays correct even if the folder is renamed. Used
 * to build same-origin URLs to bundled assets (e.g. the Skill Tree tab).
 */
export const FOLDER_NAME =
    (new URL('.', import.meta.url).pathname.replace(/\/+$/, '').split('/').pop())
    || 'SillyTavern-MultihogDnDFramework';
