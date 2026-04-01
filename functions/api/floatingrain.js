// Cloudflare Pages Function: Floating Rain Integration
// Logs into Floating Rain, fetches schedule + client data, returns aggregated JSON

const BASE = 'https://amck.floatingrain.com';

function extractSessionCookie(response) {
  // Try getSetCookie (supported in Cloudflare Workers)
  if (typeof response.headers.getSetCookie === 'function') {
    for (const c of response.headers.getSetCookie()) {
      const m = c.match(/PHPSESSID=([^;]+)/);
      if (m) return m[1];
    }
  }
  // Fallback: raw set-cookie header (may be combined)
  const raw = response.headers.get('set-cookie') || '';
  const m = raw.match(/PHPSESSID=([^;]+)/);
  if (m) return m[1];
  return null;
}

async function frLogin(env) {
  const username = (env.FR_USERNAME || '').trim();
  const password = (env.FR_PASSWORD || '').trim();
  if (!username || !password) throw new Error('Missing FR credentials');

  // Step 1: GET login page to obtain a PHPSESSID
  const loginPage = await fetch(`${BASE}/public/login`, { redirect: 'manual' });
  let sessionCookie = extractSessionCookie(loginPage);

  // If no cookie from GET, try reading the response body and follow redirects
  if (!sessionCookie) {
    const loginPage2 = await fetch(`${BASE}/public/login`);
    sessionCookie = extractSessionCookie(loginPage2);
  }
  if (!sessionCookie) throw new Error('Could not get initial session cookie');

  // Step 2: POST login
  const body = new URLSearchParams({
    username: '',
    User_text: username,
    password: password,
    Login: 'Login',
    redirectto: '/public/login'
  });

  const loginResp = await fetch(`${BASE}/public/login/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `PHPSESSID=${sessionCookie}`
    },
    body: body.toString(),
    redirect: 'manual'
  });

  // Check if login response sets a new session cookie
  const newCookie = extractSessionCookie(loginResp);
  if (newCookie) sessionCookie = newCookie;

  // If we got a redirect (302/301), follow it to complete login
  if (loginResp.status >= 300 && loginResp.status < 400) {
    const location = loginResp.headers.get('location');
    if (location) {
      const url = location.startsWith('http') ? location : `${BASE}${location}`;
      const followResp = await fetch(url, {
        headers: { 'Cookie': `PHPSESSID=${sessionCookie}` },
        redirect: 'manual'
      });
      const fc = extractSessionCookie(followResp);
      if (fc) sessionCookie = fc;
    }
  }

  // Verify login worked by checking if dashboard is accessible
  const testResp = await fetch(`${BASE}/public/dashboard`, {
    headers: { 'Cookie': `PHPSESSID=${sessionCookie}` },
    redirect: 'manual'
  });

  // If we get redirected to login, authentication failed
  const testLocation = testResp.headers.get('location') || '';
  if (testResp.status >= 300 && testLocation.includes('login')) {
    throw new Error('Login failed - check username/password');
  }

  return `PHPSESSID=${sessionCookie}`;
}

async function frFetch(cookie, path) {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { 'Cookie': cookie },
    redirect: 'manual'
  });
  // If redirected to login, session expired
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location') || '';
    if (loc.includes('login')) throw new Error('Session expired - redirected to login');
  }
  return resp;
}

export async function onRequest(context) {
  const { request, env } = context;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Login (pass env for credentials)
    const cookie = await frLogin(env);

    // Get today's date range (unix timestamps)
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 86400000);
    const startOfWeek = new Date(startOfDay);
    startOfWeek.setDate(startOfDay.getDate() - startOfDay.getDay()); // Sunday
    const endOfWeek = new Date(startOfWeek.getTime() + 7 * 86400000);

    const todayStart = Math.floor(startOfDay.getTime() / 1000);
    const todayEnd = Math.floor(endOfDay.getTime() / 1000);
    const weekStart = Math.floor(startOfWeek.getTime() / 1000);
    const weekEnd = Math.floor(endOfWeek.getTime() / 1000);

    // Also fetch a 90-day window to count unique active students
    const start90 = new Date(now.getTime() - 90 * 86400000);
    const s90 = Math.floor(start90.getTime() / 1000);
    const e90 = Math.floor(endOfWeek.getTime() / 1000);

    // Fetch schedule data (today + this week + 90-day for client count) in parallel
    const [todayResp, weekResp, longResp] = await Promise.all([
      frFetch(cookie, `/public/dashboard/gridview?do=fetch&start=${todayStart}&end=${todayEnd}&init=1&paste_id=&paste_id_type=&show_cancelled=0&show_user=`),
      frFetch(cookie, `/public/dashboard/gridview?do=fetch&start=${weekStart}&end=${weekEnd}&init=1&paste_id=&paste_id_type=&show_cancelled=0&show_user=`),
      frFetch(cookie, `/public/dashboard/gridview?do=fetch&start=${s90}&end=${e90}&init=1&paste_id=&paste_id_type=&show_cancelled=0&show_user=`)
    ]);

    const todayText = await todayResp.text();
    const weekText = await weekResp.text();
    const longText = await longResp.text();

    // Verify we got JSON, not an HTML login page
    if (todayText.startsWith('<!') || todayText.startsWith('<html')) {
      throw new Error('Authentication failed - got login page instead of data');
    }

    const todayData = JSON.parse(todayText);
    const weekData = JSON.parse(weekText);
    const longData = JSON.parse(longText);

    // Parse today's schedule
    const todayEvents = todayData.events || [];
    const todayLessons = todayEvents.filter(e => e.customer_id !== null);

    // Parse week schedule
    const weekEvents = weekData.events || [];
    const weekLessons = weekEvents.filter(e => e.customer_id !== null);

    // Classify booking codes into readable categories
    function classifyCode(code) {
      if (!code) return 'Other';
      const c = code.toUpperCase();
      if (c.startsWith('PRI') || c === 'PRIV') return 'Private';
      if (c.startsWith('GR') || c.startsWith('GRP')) return 'Group';
      if (c.includes('TRAIN') || c === 'GEN' || c.includes('COACH')) return 'Training';
      if (c.includes('WEDDING') || c === 'WED') return 'Wedding';
      if (c.includes('PARTY') || c === 'DP') return 'Party';
      if (c === 'BREAK' || c === 'DINNER' || c === 'LUNCH') return 'Break';
      if (c === 'CHKOUT' || c === 'PCHAT' || c === 'TTEA' || c === 'PORGCL') return 'Admin';
      return 'Other';
    }

    // Staff info with per-teacher daily breakdown by type
    // Step 1: Count ONLY events with customer_id (actual booked lessons)
    const dailyBreakdownByUser = {};
    todayLessons.forEach(e => {
      if (!e.userId) return;
      const cat = classifyCode(e.booking_code);
      if (cat === 'Break' || cat === 'Admin' || cat === 'Group') return; // Group handled in Step 2 by teaching assignment
      if (!dailyBreakdownByUser[e.userId]) dailyBreakdownByUser[e.userId] = {};
      dailyBreakdownByUser[e.userId][cat] = (dailyBreakdownByUser[e.userId][cat] || 0) + 1;
    });
    // Step 2: Count non-customer events (training blocks AND empty group classes)
    // These have no customer_id but still appear as blocks on the calendar.
    // Tracked separately so they bypass dcount normalization.
    const noCustomerByUser = {};
    todayEvents.forEach(e => {
      if (!e.userId) return;
      if (e.customer_id !== null && e.customer_id !== '') return; // Already counted above
      const code = (e.booking_code || '').toUpperCase();
      const text = (e.title || e.text || '').toUpperCase();
      let cat = null;
      if (code === 'GEN' || code === 'TRAIN' || code === 'COACH'
        || text.includes('TRAINING') || text.includes('COACH')) {
        cat = 'Training';
      } else if (code.startsWith('GRP') || code.startsWith('GR') || text.includes('GROUP')) {
        cat = 'Group';
      }
      if (!cat) return;
      if (!noCustomerByUser[e.userId]) noCustomerByUser[e.userId] = {};
      noCustomerByUser[e.userId][cat] = (noCustomerByUser[e.userId][cat] || 0) + 1;
    });

    const weeklyCountByUser = {};
    weekLessons.forEach(e => {
      if (e.userId) weeklyCountByUser[e.userId] = (weeklyCountByUser[e.userId] || 0) + 1;
    });

    const userList = todayData.options?.users || weekData.options?.users || [];
    const staff = userList.map(u => {
      const dcount = parseInt(u.dcount) || 0;
      const rawBreakdown = dailyBreakdownByUser[u.id] || {};
      const noCustomerCounts = noCustomerByUser[u.id] || {};
      // FR grid returns time-slot events (e.g. 30-min blocks), so raw counts
      // can be ~2x the actual lesson count. Normalize using FR's authoritative dcount.
      // Step 1 (rawBreakdown) only has customer-id events — normalize those to dcount.
      const rawLessonTotal = Object.values(rawBreakdown).reduce((s, v) => s + v, 0);
      const normalizedBreakdown = {};
      if (rawLessonTotal > 0 && dcount > 0) {
        const scale = dcount / rawLessonTotal;
        let assigned = 0;
        const entries = Object.entries(rawBreakdown);
        entries.forEach(([cat, count], i) => {
          if (i === entries.length - 1) {
            normalizedBreakdown[cat] = dcount - assigned; // last category gets remainder
          } else {
            const scaled = Math.floor(count * scale);
            normalizedBreakdown[cat] = scaled;
            assigned += scaled;
          }
        });
      }
      // Add non-customer events (training, empty group classes) on top — these
      // are not included in FR's dcount so they bypass normalization.
      Object.entries(noCustomerCounts).forEach(([cat, count]) => {
        normalizedBreakdown[cat] = (normalizedBreakdown[cat] || 0) + count;
      });
      return {
        id: u.id,
        name: u.name,
        dailyLessons: dcount,
        weeklyLessons: parseInt(u.wcount) || weeklyCountByUser[u.id] || 0,
        dailyBreakdown: normalizedBreakdown
      };
    });

    // Lesson type breakdown for today
    const lessonTypes = {};
    todayLessons.forEach(l => {
      const type = l.booking_code || 'OTHER';
      lessonTypes[type] = (lessonTypes[type] || 0) + 1;
    });

    // Weekly lesson type breakdown
    const weekLessonTypes = {};
    weekEvents.forEach(e => {
      if (!e.customer_id) return;
      const type = e.booking_code || 'OTHER';
      weekLessonTypes[type] = (weekLessonTypes[type] || 0) + 1;
    });

    // Extract active students from 90-day schedule data
    const longEvents = longData.events || [];
    const customerMap = new Map();
    longEvents.forEach(ev => {
      if (!ev.customer_id) return;
      const ids = ev.customer_id.split(',').map(id => id.trim()).filter(Boolean);
      ids.forEach(cid => {
        const existing = customerMap.get(cid) || { id: cid, lessonCount: 0, lastSeen: '', teachers: new Set() };
        existing.lessonCount++;
        const evDate = ev.start?.split('T')[0] || '';
        if (evDate > existing.lastSeen) existing.lastSeen = evDate;
        if (ev.userId) existing.teachers.add(ev.userId);
        customerMap.set(cid, existing);
      });
    });

    const activeClients = customerMap.size;
    const clientData = [...customerMap.values()]
      .sort((a, b) => b.lessonCount - a.lessonCount)
      .slice(0, 50)
      .map(c => ({
        userId: c.id,
        name: c.id,
        lessonCount: c.lessonCount,
        lastSeen: c.lastSeen,
        teachers: [...c.teachers].join(', ')
      }));

    // Summary stats
    const totalStaffLessonsToday = staff.reduce((s, t) => s + t.dailyLessons, 0);
    const totalStaffLessonsWeek = staff.reduce((s, t) => s + t.weeklyLessons, 0);
    const activeStaff = staff.filter(t => t.dailyLessons > 0);

    // Weekly-by-day excluding non-lesson codes
    const nonLessonCodes = new Set(['CHKOUT', 'PCHAT', 'TTEA', 'PORGCL', 'BREAK', 'DINNER']);
    const weeklyByDayFiltered = {};
    weekEvents.forEach(e => {
      if (!e.customer_id) return;
      if (nonLessonCodes.has(e.booking_code)) return;
      const day = e.start?.split('T')[0] || 'unknown';
      weeklyByDayFiltered[day] = (weeklyByDayFiltered[day] || 0) + 1;
    });

    const result = {
      studio: 'Arthur Murray Castle Rock',
      fetched_at: new Date().toISOString(),
      today: {
        date: startOfDay.toISOString().split('T')[0],
        total_events: todayEvents.length,
        lessons: totalStaffLessonsToday,
        lesson_types: lessonTypes,
        active_teachers: activeStaff.length,
        total_teachers: staff.length
      },
      week: {
        start: startOfWeek.toISOString().split('T')[0],
        end: endOfWeek.toISOString().split('T')[0],
        total_lessons: totalStaffLessonsWeek,
        lessons_by_day: weeklyByDayFiltered,
        lesson_types: weekLessonTypes
      },
      staff,
      clients: {
        active_count: activeClients,
        sample: clientData.slice(0, 20)
      },
      kpis: {
        lessons_today: totalStaffLessonsToday,
        lessons_this_week: totalStaffLessonsWeek,
        active_students: activeClients,
        active_teachers: activeStaff.length,
        total_staff: staff.length,
        avg_lessons_per_teacher_week: activeStaff.length > 0
          ? Math.round(totalStaffLessonsWeek / activeStaff.length * 10) / 10
          : 0
      }
    };

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
