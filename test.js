const fs = require('fs');

fs.readFile('proxies.txt', 'utf8', (err, data) => {
    if (err) {
        console.error(err);
        return;
    }

    const proxies = data.split('\n');
    const updatedProxies = proxies.map(proxy => `http://${proxy.trim()}`);

    fs.writeFile('proxies.txt', updatedProxies.join('\n'), (err) => {
        if (err) {
            console.error(err);
            return;
        }
        console.log('Updated proxies.txt');
    });
});
