const https = require('https');
const fs = require('fs');

const url = 'https://lod.nexon.com/Community/game/7755?SearchBoard=1&Category2=1&SearchType=0&SearchKeyword=%EB%B0%9C%EB%A1%9D';

https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        fs.writeFileSync('post_source.html', data);
        console.log('HTML saved to post_source.html');
    });
}).on('error', (err) => {
    console.error('Error:', err.message);
});
