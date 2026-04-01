// Cloudflare Pages Function: MailChimp API Proxy
// Securely calls MailChimp API server-side so the API key is never exposed to the browser

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export async function onRequest(context) {
  const { request, env } = context;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders });
  }

  const API_KEY = env.MAILCHIMP_API_KEY;
  if (!API_KEY) {
    return new Response(JSON.stringify({ error: 'MAILCHIMP_API_KEY not configured' }), {
      status: 500, headers: corsHeaders
    });
  }

  const SERVER = API_KEY.split('-').pop();
  const BASE = `https://${SERVER}.api.mailchimp.com/3.0`;
  const headers = {
    'Authorization': `apikey ${API_KEY}`,
    'Content-Type': 'application/json'
  };

  async function mcFetch(path) {
    const res = await fetch(`${BASE}${path}`, { headers });
    if (!res.ok) throw new Error(`MailChimp API error: ${res.status}`);
    return res.json();
  }

  try {
    // Fetch all the data the dashboard needs in parallel
    const [account, lists, campaigns, automations] = await Promise.all([
      mcFetch('/'),
      mcFetch('/lists?count=10&fields=lists.id,lists.name,lists.stats,lists.date_created'),
      mcFetch('/campaigns?count=20&sort_field=send_time&sort_dir=DESC&fields=campaigns.id,campaigns.settings.title,campaigns.settings.subject_line,campaigns.emails_sent,campaigns.report_summary,campaigns.send_time,campaigns.status,campaigns.type'),
      mcFetch('/automations?count=10&fields=automations.id,automations.settings.title,automations.status,automations.emails_sent,automations.report_summary')
    ]);

    // Aggregate list stats
    const totalSubscribers = lists.lists.reduce((sum, l) => sum + (l.stats?.member_count || 0), 0);
    const totalUnsubscribes = lists.lists.reduce((sum, l) => sum + (l.stats?.unsubscribe_count || 0), 0);

    // Process campaigns for recent performance
    const sentCampaigns = campaigns.campaigns.filter(c => c.status === 'sent' && c.report_summary);
    const avgOpenRate = sentCampaigns.length > 0
      ? sentCampaigns.reduce((sum, c) => sum + (c.report_summary?.open_rate || 0), 0) / sentCampaigns.length
      : 0;
    const avgClickRate = sentCampaigns.length > 0
      ? sentCampaigns.reduce((sum, c) => sum + (c.report_summary?.click_rate || 0), 0) / sentCampaigns.length
      : 0;

    // Build response
    const data = {
      account: {
        name: account.account_name,
        email: account.email,
        total_subscribers: account.total_subscribers
      },
      kpis: {
        total_subscribers: totalSubscribers,
        total_unsubscribes: totalUnsubscribes,
        avg_open_rate: (avgOpenRate * 100).toFixed(1),
        avg_click_rate: (avgClickRate * 100).toFixed(1),
        campaigns_sent: sentCampaigns.length
      },
      lists: lists.lists.map(l => ({
        id: l.id,
        name: l.name,
        member_count: l.stats?.member_count || 0,
        unsubscribe_count: l.stats?.unsubscribe_count || 0,
        open_rate: (l.stats?.open_rate || 0).toFixed(1),
        click_rate: (l.stats?.click_rate || 0).toFixed(1)
      })),
      recent_campaigns: sentCampaigns.slice(0, 10).map(c => ({
        title: c.settings?.title || c.settings?.subject_line || 'Untitled',
        subject: c.settings?.subject_line || '',
        sent: c.emails_sent || 0,
        open_rate: ((c.report_summary?.open_rate || 0) * 100).toFixed(1),
        click_rate: ((c.report_summary?.click_rate || 0) * 100).toFixed(1),
        send_time: c.send_time,
        opens: c.report_summary?.opens || 0,
        clicks: c.report_summary?.subscriber_clicks || 0
      })),
      automations: (automations.automations || []).map(a => ({
        title: a.settings?.title || 'Untitled',
        status: a.status,
        emails_sent: a.emails_sent || 0
      })),
      fetched_at: new Date().toISOString()
    };

    return new Response(JSON.stringify(data), { status: 200, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders
    });
  }
}
