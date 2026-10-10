/**
 * extensions/upstream-error-extractor.ts
 *
 * 分类器上游异常提取与排障诊断器
 *
 * 从未知异常对象或响应错误报文中精确解析 HTTP 状态码与特征错误分类，
 * 避免裸 catch 将 403 锁区、401 凭据失效、网络中断等异常笼统吞没为 generic exception，
 * 并提供紧凑短码 shortCode 与高可读性诊断排障建议 diagnosticHint。
 */

export type UpstreamErrorCategory =
	| "region_blocked"
	| "auth_failed"
	| "rate_limited"
	| "network_error"
	| "generic_upstream";

export interface UpstreamErrorInfo {
	statusCode?: number;
	rawMessage: string;
	category: UpstreamErrorCategory;
	shortCode: string;
	diagnosticHint: string;
}

/**
 * 从未知异常对象或错误字符串中提取结构化上游诊断信息
 *
 * @param err 捕获到的异常或错误响应
 * @returns 规范化的 UpstreamErrorInfo
 */
export function extractUpstreamErrorInfo(err: unknown): UpstreamErrorInfo {
	let rawMessage = "";
	let statusCode: number | undefined;

	if (typeof err === "string") {
		rawMessage = err;
	} else if (err && typeof err === "object") {
		const obj = err as Record<string, any>;
		// 1. 尝试直接获取数字状态码
		if (typeof obj.status === "number") {
			statusCode = obj.status;
		} else if (typeof obj.statusCode === "number") {
			statusCode = obj.statusCode;
		} else if (typeof obj.response?.status === "number") {
			statusCode = obj.response.status;
		} else if (typeof obj.code === "number") {
			statusCode = obj.code;
		}

		// 2. 获取原始报文
		rawMessage =
			obj.message ||
			obj.errorMessage ||
			obj.response?.data?.error?.message ||
			obj.response?.statusText ||
			String(err);
	} else {
		rawMessage = String(err ?? "unknown error");
	}

	// 3. 若未通过属性拿到状态码，从报文中正则匹配常见 HTTP 状态码
	if (statusCode === undefined) {
		const codeMatch = rawMessage.match(/(?:status code |HTTP |status:?\s*|error:?\s*)(\b[45]\d{2}\b)/i);
		if (codeMatch) {
			statusCode = Number.parseInt(codeMatch[1], 10);
		} else {
			// 补充特定经典状态码匹配
			const standaloneMatch = rawMessage.match(/\b(401|403|429|500|502|503|504)\b/);
			if (standaloneMatch) {
				statusCode = Number.parseInt(standaloneMatch[1], 10);
			}
		}
	}

	const lowerMsg = rawMessage.toLowerCase();

	// 4. 403 / 锁区检测 (region_blocked)
	if (
		statusCode === 403 ||
		lowerMsg.includes("forbidden") ||
		lowerMsg.includes("access denied") ||
		lowerMsg.includes("region") ||
		lowerMsg.includes("country") ||
		lowerMsg.includes("territory") ||
		lowerMsg.includes("cloudflare") ||
		lowerMsg.includes("not supported in your country") ||
		lowerMsg.includes("blocked by provider")
	) {
		const codeStr = statusCode ?? 403;
		return {
			statusCode: codeStr,
			rawMessage,
			category: "region_blocked",
			shortCode: `upstream_${codeStr}(Region Blocked)`,
			diagnosticHint:
				"上游模型提供方拒绝了访问（疑似地域锁区或访问受限 403）。建议检查网络代理分流规则，确保 API 域名走海外支持区域节点。",
		};
	}

	// 5. 401 / 认证失败 (auth_failed)
	if (
		statusCode === 401 ||
		lowerMsg.includes("unauthorized") ||
		lowerMsg.includes("invalid api key") ||
		lowerMsg.includes("incorrect api key") ||
		lowerMsg.includes("authentication") ||
		lowerMsg.includes("bearer token")
	) {
		const codeStr = statusCode ?? 401;
		return {
			statusCode: codeStr,
			rawMessage,
			category: "auth_failed",
			shortCode: `upstream_${codeStr}(Auth Failed)`,
			diagnosticHint:
				"上游 API 认证失败（401 Unauthorized）。建议检查 API Key 是否有效、是否已过期或是否有对应模型的调用权限。",
		};
	}

	// 6. 429 / 频控限流 (rate_limited)
	if (
		statusCode === 429 ||
		lowerMsg.includes("rate limit") ||
		lowerMsg.includes("quota") ||
		lowerMsg.includes("too many requests")
	) {
		const codeStr = statusCode ?? 429;
		return {
			statusCode: codeStr,
			rawMessage,
			category: "rate_limited",
			shortCode: `upstream_${codeStr}(Rate Limited)`,
			diagnosticHint:
				"上游请求频率过高或账户额度耗尽（429 Too Many Requests）。建议稍后重试或检查账户可用额度。",
		};
	}

	// 7. 网络底层连接或代理异常 (network_error)
	if (
		lowerMsg.includes("econnrefused") ||
		lowerMsg.includes("enotfound") ||
		lowerMsg.includes("fetch failed") ||
		lowerMsg.includes("econnreset") ||
		lowerMsg.includes("socket hang up") ||
		lowerMsg.includes("proxy") ||
		lowerMsg.includes("etimedout")
	) {
		return {
			statusCode,
			rawMessage,
			category: "network_error",
			shortCode: "network_error",
			diagnosticHint:
				"连接上游 API 失败，本地网络或代理服务中断。建议检查网络连通性及本地代理服务端口配置。",
		};
	}

	// 8. 其他上游异常 (generic_upstream)
	return {
		statusCode,
		rawMessage,
		category: "generic_upstream",
		shortCode: statusCode ? `upstream_${statusCode}` : "stage2_exception",
		diagnosticHint:
			"上游模型调用异常。建议查看控制台详细报错堆栈以定位具体原因。",
	};
}
