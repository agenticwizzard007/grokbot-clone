// Seed only the disposable database capability created by qualityServer.
export function seedWidgetData(server) {
  if (server.widgetDataSeeded) return;
  server.withDb(db => {
    const now = Date.now();
    db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('routine_uc_h_weekly', server.fixture.bot.id, 'Fixture routine', 'PRIVATE_FIXTURE_PROMPT', '0 9 * * *', 'UTC', 1, now);
    const usage = db.prepare('INSERT INTO usage_events(user_id,bot_id,kind,provider,model,input_tokens,output_tokens,cost_usd,cost_source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (let day = 0; day < 7; day++) usage.run(server.fixture.userId, server.fixture.bot.id, 'chat', 'direct', 'fixture-model', 100, 20, 0.25, 'provider', now - day * 86400000);
  });
  server.widgetDataSeeded = true;
}
