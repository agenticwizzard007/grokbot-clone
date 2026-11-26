import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinToolIcon } from '../web/src/lib/builtinToolIcon.js';

test('internal tool icons cover skills, memory, tasks, routines, files, chat search and computer actions', () => {
  const groups = {
    skill: ['propose_skill', 'manage_skill', 'list_skills', 'search_skills', ' PROPOSE_SKILL '],
    memory: ['remember', 'forget', 'manage_memory', 'search_memories'],
    task: ['create_task', 'update_task'],
    routine: ['create_routine', 'create_event_routine', 'list_routines', 'update_routine', 'delete_routine', 'routine_history', 'set_checkins'],
    file: ['save_file', 'list_deliverables', 'deliver_artifact'],
    search: ['session_search', 'past_chat_search'],
    browser: ['browser', 'open_browser', 'wait_for_browser_access', 'browser_search'],
    computer: ['computer', 'computer_screenshot', 'computer_click', 'computer_type', 'computer_key', 'computer_scroll', 'computer_drag', 'shell'],
  };
  for (const [icon, tools] of Object.entries(groups)) for (const tool of tools) assert.equal(builtinToolIcon(tool), icon, tool);
});

test('unrecognized internal actions have a neutral icon instead of a letter', () => {
  for (const tool of ['', 'future_builtin_action', 'update_profile:timezone', 'create_bot', 'ask_user', '__proto__']) assert.equal(builtinToolIcon(tool), 'generic', tool);
});
