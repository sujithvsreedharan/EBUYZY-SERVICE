const clients = new Map();   // userId -> Set of open responses (one per tab or device)

function addClient(userId, res) {
    if (!clients.has(userId)) clients.set(userId, new Set());
    clients.get(userId).add(res);
}

function removeClient(userId, res) {
    const set = clients.get(userId);
    if (!set) return;
    set.delete(res);
    if (!set.size) clients.delete(userId);
}

function push(userId, notification) {
    for (const res of clients.get(userId) || []) {
        res.write(`event: notification\ndata: ${JSON.stringify(notification)}\n\n`);
    }
}

// rows come straight from the stored procedure
const pushMany = (rows = []) => rows.forEach((n) => push(n.userId, n));

module.exports = { addClient, removeClient, pushMany };