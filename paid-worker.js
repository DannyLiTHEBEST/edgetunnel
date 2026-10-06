import upstreamWorker from './_worker.js';

// Cloudflare Workers Paid 默认包含 10,000,000 次请求/月。
// 可在 Cloudflare 环境变量中覆盖：
//   CF_REQUEST_LIMIT = 10000000
//   CF_BILLING_DAY   = 1   // 1-31；如需与实际续费日一致，可设置为续费日
const 默认月请求上限 = 10_000_000;

function 获取请求上限(env) {
	const value = Number.parseInt(String(env?.CF_REQUEST_LIMIT ?? ''), 10);
	return Number.isFinite(value) && value > 0 ? value : 默认月请求上限;
}

function 获取计费周期起点(env, now = new Date()) {
	const configured = Number.parseInt(String(env?.CF_BILLING_DAY ?? '1'), 10);
	const billingDay = Number.isFinite(configured) ? Math.min(31, Math.max(1, configured)) : 1;
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	const daysThisMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	let start = new Date(Date.UTC(year, month, Math.min(billingDay, daysThisMonth), 0, 0, 0, 0));

	if (now < start) {
		const previousMonth = new Date(Date.UTC(year, month - 1, 1));
		const previousYear = previousMonth.getUTCFullYear();
		const previousMonthIndex = previousMonth.getUTCMonth();
		const daysPreviousMonth = new Date(Date.UTC(previousYear, previousMonthIndex + 1, 0)).getUTCDate();
		start = new Date(Date.UTC(previousYear, previousMonthIndex, Math.min(billingDay, daysPreviousMonth), 0, 0, 0, 0));
	}

	return start;
}

async function 获取Cloudflare月度用量(Email, GlobalAPIKey, AccountID, APIToken, env) {
	const API = 'https://api.cloudflare.com/client/v4';
	const max = 获取请求上限(env);
	const sum = (items) => items?.reduce((total, item) => total + (item?.sum?.requests || 0), 0) || 0;
	const baseHeaders = { 'Content-Type': 'application/json' };

	try {
		if (!AccountID && (!Email || !GlobalAPIKey)) {
			return { success: false, pages: 0, workers: 0, total: 0, max };
		}

		if (!AccountID) {
			const accountResponse = await fetch(`${API}/accounts`, {
				method: 'GET',
				headers: { ...baseHeaders, 'X-AUTH-EMAIL': Email, 'X-AUTH-KEY': GlobalAPIKey }
			});
			if (!accountResponse.ok) throw new Error(`账户获取失败: ${accountResponse.status}`);
			const accountData = await accountResponse.json();
			if (!accountData?.result?.length) throw new Error('未找到账户');
			const index = accountData.result.findIndex(account => account.name?.toLowerCase().startsWith(String(Email).toLowerCase()));
			AccountID = accountData.result[index >= 0 ? index : 0]?.id;
		}

		const now = new Date();
		const periodStart = 获取计费周期起点(env, now);
		const headers = APIToken
			? { ...baseHeaders, Authorization: `Bearer ${APIToken}` }
			: { ...baseHeaders, 'X-AUTH-EMAIL': Email, 'X-AUTH-KEY': GlobalAPIKey };

		const response = await fetch(`${API}/graphql`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				query: `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
					viewer { accounts(filter: {accountTag: $AccountID}) {
						pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
						workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
					} }
				}`,
				variables: {
					AccountID,
					filter: {
						datetime_geq: periodStart.toISOString(),
						datetime_leq: now.toISOString()
					}
				}
			})
		});

		if (!response.ok) throw new Error(`查询失败: ${response.status}`);
		const result = await response.json();
		if (result.errors?.length) throw new Error(result.errors[0].message);

		const account = result?.data?.viewer?.accounts?.[0];
		if (!account) throw new Error('未找到账户数据');

		const pages = sum(account.pagesFunctionsInvocationsAdaptiveGroups);
		const workers = sum(account.workersInvocationsAdaptive);
		const total = pages + workers;
		return {
			success: true,
			pages,
			workers,
			total,
			max,
			periodStart: periodStart.toISOString(),
			periodEnd: now.toISOString()
		};
	} catch (error) {
		console.error('[Paid Usage Wrapper] 获取使用量错误:', error?.message || error);
		return { success: false, pages: 0, workers: 0, total: 0, max };
	}
}

async function 读取CF配置(env) {
	try {
		if (!env?.KV || typeof env.KV.get !== 'function') return null;
		const raw = await env.KV.get('cf.json');
		if (!raw) return null;
		const config = JSON.parse(raw);
		// 外部 UsageAPI 的统计口径未知，为避免错误覆盖，存在 UsageAPI 时沿用上游结果。
		if (config?.UsageAPI) return null;
		return config;
	} catch (error) {
		console.error('[Paid Usage Wrapper] 读取 cf.json 失败:', error?.message || error);
		return null;
	}
}

async function 从KV获取月度用量(env) {
	const config = await 读取CF配置(env);
	if (!config) return null;
	return 获取Cloudflare月度用量(config.Email, config.GlobalAPIKey, config.AccountID, config.APIToken, env);
}

function 写入订阅用量头(response, usage) {
	if (!usage?.success) return response;
	const headers = new Headers(response.headers);
	const scale = 1024 / 1000;
	// Subscription-Userinfo 使用“字节”字段承载请求次数；统一缩放可保持百分比精确。
	const upload = Math.round(usage.pages * scale);
	const download = Math.round(usage.workers * scale);
	const total = Math.round(usage.max * scale);
	headers.set('Subscription-Userinfo', `upload=${upload}; download=${download}; total=${total}; expire=4102329600`);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		// 先交给上游处理认证、代理、订阅生成等全部逻辑，避免改变原项目行为。
		let response = await upstreamWorker.fetch(request, env, ctx);
		if (!response || !response.ok) return response;

		if (path === '/admin/getCloudflareUsage') {
			const usage = await 获取Cloudflare月度用量(
				url.searchParams.get('Email'),
				url.searchParams.get('GlobalAPIKey'),
				url.searchParams.get('AccountID'),
				url.searchParams.get('APIToken'),
				env
			);
			return new Response(JSON.stringify(usage, null, 2), {
				status: 200,
				headers: { 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' }
			});
		}

		if (path === '/admin/config.json' && request.method === 'GET') {
			try {
				const data = await response.clone().json();
				const usage = await 从KV获取月度用量(env);
				if (usage?.success && data?.CF) {
					data.CF.Usage = usage;
					const headers = new Headers(response.headers);
					headers.set('Content-Type', 'application/json;charset=utf-8');
					headers.set('Cache-Control', 'no-store');
					response = new Response(JSON.stringify(data, null, 2), { status: response.status, statusText: response.statusText, headers });
				}
			} catch (error) {
				console.error('[Paid Usage Wrapper] 修改管理面板用量失败:', error?.message || error);
			}
			return response;
		}

		if (path === '/sub') {
			const usage = await 从KV获取月度用量(env);
			return 写入订阅用量头(response, usage);
		}

		return response;
	}
};
