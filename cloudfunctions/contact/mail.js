/**
 * 留言邮件通知 —— 只用 Node 内置模块实现的极简 SMTP 客户端
 *
 * 为什么不用 nodemailer：
 *   本项目一直刻意保持零依赖。nodemailer 及其传递依赖会让云函数包体积涨一大截，
 *   冷启动变慢，部署还得走云端 npm install。而我们要做的事很窄——连上一个 SMTP
 *   服务器、认证、发一封纯文本邮件，用内置的 net/tls 模块一百多行就够了，
 *   出了问题也能自己逐行看懂。
 *
 * 端口怎么选：
 *   587 + STARTTLS 是默认（先明文连，再升级成 TLS）。腾讯云默认封禁 25 端口出站，
 *   587 未见封堵；本机实测 smtp.qq.com:587 可连通、支持 AUTH LOGIN、能升到 TLS 1.3。
 *   465（隐式 TLS，一上来就是加密连接）也实现了，把 MAIL_PORT 改成 465 即可切换，
 *   不用改代码重新部署——某些网络环境下 465 反而更顺。
 *
 * 全部配置来自环境变量，代码里不出现任何密钥：
 *   MAIL_HOST  SMTP 服务器，默认 smtp.qq.com
 *   MAIL_PORT  默认 587；填 465 则走隐式 TLS
 *   MAIL_USER  发件邮箱（同时也是 SMTP 登录账号）
 *   MAIL_PASS  邮箱的「客户端授权码」，不是邮箱登录密码
 *   MAIL_TO    收件邮箱，默认等于 MAIL_USER
 *   MAIL_NAME  发件人显示名，默认「作品集站点」
 *
 * 未配置 MAIL_USER / MAIL_PASS 时，sendMail 返回 skipped 而不抛错——
 * 没配通知不应该让留言功能挂掉。
 */

'use strict';

const net = require('net');
const tls = require('tls');

const DEFAULT_HOST = 'smtp.qq.com';
const DEFAULT_PORT = 587;
const DEFAULT_TIMEOUT = 8000;
const DEFAULT_NAME = '作品集站点';

/**
 * 一条 SMTP 应答是否收完了。
 * 多行应答的规则是：续行以「数字-」开头，最后一行以「数字 」开头（空格不是减号）。
 */
function isComplete(buffer) {
    const lines = buffer.split('\r\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i] === '') continue;
        return /^\d{3} /.test(lines[i]);
    }
    return false;
}

/** 等一条完整应答，返回 { code, text } */
function readReply(socket) {
    return new Promise((resolve, reject) => {
        let buffer = '';

        const onData = (chunk) => {
            buffer += chunk;
            if (!isComplete(buffer)) return;
            cleanup();
            resolve({ code: parseInt(buffer.slice(0, 3), 10), text: buffer.trim() });
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onEnd = () => {
            cleanup();
            reject(new Error('SMTP 服务器在应答完成前关闭了连接'));
        };
        const onTimeout = () => {
            cleanup();
            socket.destroy();
            reject(new Error('等待 SMTP 应答超时'));
        };

        function cleanup() {
            socket.removeListener('data', onData);
            socket.removeListener('error', onError);
            socket.removeListener('end', onEnd);
            socket.removeListener('timeout', onTimeout);
        }

        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('end', onEnd);
        socket.on('timeout', onTimeout);
    });
}

/** 发一行命令并等应答；返回码不在 allowCodes 里视为失败 */
async function command(socket, line, allowCodes) {
    const waiting = readReply(socket);
    socket.write(line + '\r\n');
    const reply = await waiting;
    if (allowCodes.indexOf(reply.code) < 0) {
        throw new Error(`SMTP 命令失败（${reply.code}）: ${reply.text}`);
    }
    return reply;
}

/**
 * 邮件标题里的中文必须编码，不能直接写进信头。
 * 用 RFC 2047 的 base64 形式：=?UTF-8?B?...?=
 */
function encodeHeader(text) {
    return '=?UTF-8?B?' + Buffer.from(String(text), 'utf8').toString('base64') + '?=';
}

/**
 * 正文整段 base64 编码。
 * 三个好处：中文不会乱码、不受每行长度限制、不会出现以句点开头的行
 * （那种行在 DATA 阶段会被当成结束符，必须做点填充转义；base64 字符集里没有句点）。
 */
function encodeBody(text) {
    return Buffer.from(String(text), 'utf8')
        .toString('base64')
        .replace(/(.{76})/g, '$1\r\n');
}

/** 组装一封纯文本邮件（RFC 5322 原始报文） */
function buildMessage({ from, to, subject, body }) {
    return [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${encodeHeader(subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        encodeBody(body)
    ].join('\r\n');
}

/**
 * 建立连接：465 直接建 TLS，其余先建明文 TCP（稍后 STARTTLS 升级）。
 * 连接阶段也受超时保护——网络被拦时往往不是立刻报错，而是一直挂着。
 */
function connect(host, port, timeout) {
    return new Promise((resolve, reject) => {
        const socket = (port === 465)
            ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
            : net.connect({ host, port });

        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onTimeout = () => {
            cleanup();
            socket.destroy();
            reject(new Error(`连接 ${host}:${port} 超时`));
        };
        const onReady = () => {
            cleanup();
            resolve(socket);
        };

        function cleanup() {
            socket.removeListener('error', onError);
            socket.removeListener('timeout', onTimeout);
            socket.removeListener('secureConnect', onReady);
            socket.removeListener('connect', onReady);
        }

        // 闲置超时：之后每次收到数据都会重置计时，readReply 负责接住超时事件
        socket.setTimeout(timeout);
        socket.once('error', onError);
        socket.once('timeout', onTimeout);
        socket.once(port === 465 ? 'secureConnect' : 'connect', onReady);
    });
}

/** 把已建立的明文连接升级为 TLS，返回新的加密 socket */
function upgrade(socket, host) {
    return new Promise((resolve, reject) => {
        // 原 socket 上还有 readReply 留下的监听，交给新 socket 之前先摘掉
        socket.removeAllListeners('data');
        socket.removeAllListeners('end');
        socket.removeAllListeners('timeout');

        const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true });
        const onError = (error) => {
            secure.removeListener('secureConnect', onReady);
            reject(error);
        };
        const onReady = () => {
            secure.removeListener('error', onError);
            resolve(secure);
        };
        secure.once('error', onError);
        secure.once('secureConnect', onReady);
    });
}

/**
 * 发一封信。
 * 返回 { ok: true, detail } 表示成功；{ ok: false, skipped: true } 表示没配置，跳过。
 * 其余情况抛错，由调用方决定怎么处理。
 */
async function sendMail({ subject, body, timeout = DEFAULT_TIMEOUT }) {
    const host = (process.env.MAIL_HOST || DEFAULT_HOST).trim();
    const port = parseInt(process.env.MAIL_PORT || String(DEFAULT_PORT), 10);
    const user = (process.env.MAIL_USER || '').trim();
    const pass = (process.env.MAIL_PASS || '').trim();
    const to = (process.env.MAIL_TO || user).trim();
    const name = (process.env.MAIL_NAME || DEFAULT_NAME).trim();

    if (!user || !pass || !to) {
        return { ok: false, skipped: true, reason: '未配置 MAIL_USER / MAIL_PASS，已跳过发信' };
    }

    const message = buildMessage({
        from: `${encodeHeader(name)} <${user}>`,
        to,
        subject,
        body
    });

    let socket = await connect(host, port, timeout);
    socket.setEncoding('utf8');

    try {
        // 连接建立后服务器会主动发一条 220 问候
        const greet = await readReply(socket);
        if (greet.code !== 220) {
            throw new Error(`SMTP 问候异常（${greet.code}）: ${greet.text}`);
        }

        await command(socket, 'EHLO localhost', [250]);

        if (port !== 465) {
            await command(socket, 'STARTTLS', [220]);
            socket = await upgrade(socket, host);
            socket.setEncoding('utf8');
            socket.setTimeout(timeout);
            // 升级后必须重新 EHLO，服务能力可能变了
            await command(socket, 'EHLO localhost', [250]);
        }

        // AUTH LOGIN：账号和口令分别 base64 编码，分两步提交
        await command(socket, 'AUTH LOGIN', [334]);
        await command(socket, Buffer.from(user, 'utf8').toString('base64'), [334]);
        await command(socket, Buffer.from(pass, 'utf8').toString('base64'), [235]);

        await command(socket, `MAIL FROM:<${user}>`, [250]);
        await command(socket, `RCPT TO:<${to}>`, [250, 251]);
        await command(socket, 'DATA', [354]);
        // 单独一个句点表示正文结束（command 会自动补 \r\n）
        await command(socket, message + '\r\n.', [250]);

        try {
            await command(socket, 'QUIT', [221]);
        } catch {
            // 信已经发出去了，断开时的应答无所谓
        }

        return { ok: true, detail: `已投递到 ${to}` };
    } finally {
        socket.destroy();
    }
}

/**
 * 把一条留言渲染成邮件正文。
 * 带上邮箱和来源信息，方便直接在邮件客户端里点回复。
 */
function renderMessageMail(record) {
    const time = new Date(record.createdAt || Date.now());
    // 云函数时区为 UTC，转成北京时间再展示
    const local = new Date(time.getTime() + 8 * 3600 * 1000);
    const stamp = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-` +
        `${String(local.getUTCDate()).padStart(2, '0')} ` +
        `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;

    const lines = [
        `姓名：${record.name}`,
        `邮箱：${record.email}`,
        `时间：${stamp}（北京时间）`,
        `来源 IP：${record.ip || '未知'}`
    ];
    // 浏览器标识没必要占一行，拿不到就整行省掉
    if (record.ua) lines.push(`浏览器：${record.ua}`);
    lines.push(
        '',
        '留言内容：',
        '------------------------------',
        record.message,
        '------------------------------',
        '',
        '（直接回复本邮件即可联系对方）'
    );
    return lines.join('\r\n');
}

module.exports = { sendMail, renderMessageMail, buildMessage, encodeHeader };

// 下面这几个是内部步骤，一并导出是为了本地自检脚本能不走登录就验证握手是否通畅。
// 生产调用只会用到 sendMail。
module.exports.__internals = { connect, command, readReply, upgrade };
