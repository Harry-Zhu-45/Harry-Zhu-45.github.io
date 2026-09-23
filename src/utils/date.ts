// 全站统一的日期工具：所有 URL / 展示时间都从东八区墙钟取值
import { SITE_TIME_ZONE } from '../consts';

const partsFmt = new Intl.DateTimeFormat('en-CA', {
	timeZone: SITE_TIME_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

/** Date → { year: '2024', month: '02', day: '16' }（东八区墙钟） */
export function dateParts(date: Date) {
	const p = Object.fromEntries(
		partsFmt.formatToParts(date).map((x) => [x.type, x.value]),
	);
	return { year: p.year, month: p.month, day: p.day };
}

/** Date → '2024-02-16'（东八区墙钟） */
export function formatDate(date: Date) {
	const { year, month, day } = dateParts(date);
	return `${year}-${month}-${day}`;
}
