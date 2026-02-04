const { CommunityService } = require('./src/services/communityService');

async function test() {
    const service = new CommunityService();
    console.log('Searching for "발록"...');
    try {
        const result = await service.searchAndParse('발록');
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error);
    }
}

test();
