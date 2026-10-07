"""Optional edge-tts adapter. Receives JSON on stdin; never shells user text."""
import asyncio
import json
import sys
import edge_tts

async def main():
    request = json.load(sys.stdin)
    if request['action'] == 'check':
        print('{}')
    elif request['action'] == 'voices':
        voices = await edge_tts.list_voices()
        print(json.dumps([{'id': v['ShortName'], 'name': v['ShortName'], 'language': v['Locale'],
                           'gender': v['Gender'], 'provider': 'edge', 'online': True}
                          for v in voices if v['Locale'].startswith(('es-', 'en-'))]))
    elif request['action'] == 'synthesize':
        voice = request['voice']
        await edge_tts.Communicate(request['text'], voice, rate=request['rate'], volume=request['volume']).save(request['output'])
        print('{}')
    else:
        raise ValueError('Unknown action')

asyncio.run(main())
