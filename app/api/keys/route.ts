// Which optional .env keys are configured — booleans only, never the values.
// Settings → Status uses this to show per-source key state.
export async function GET() {
  return Response.json({
    fires: !!process.env.FIRMS_MAP_KEY,
    agent: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      google: !!process.env.GOOGLE_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
      groq: !!process.env.GROQ_API_KEY,
      deepseek: !!process.env.DEEPSEEK_API_KEY,
    },
  });
}
