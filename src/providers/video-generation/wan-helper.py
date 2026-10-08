"""Optional Wan adapter. No model download, payment, retries or shell invocation."""
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def space_client(download_dir):
    from gradio_client import Client
    return Client(os.environ['WAN_SPACE_ID'], token=os.environ.get('HF_TOKEN'),
                  verbose=False, download_files=download_dir, analytics_enabled=False,
                  httpx_kwargs={'timeout': 20})


def space_arguments(request):
    from gradio_client import handle_file
    # Exact keyword names come from the selected Space's Use via API page.
    # Backend configuration only. Missing mappings fail before GPU submission.
    args = json.loads(os.environ['WAN_SPACE_ARGS'])
    if not isinstance(args, dict) or '$prompt' not in args.values():
        raise ValueError('WAN_SPACE_ARGS must map a parameter to $prompt')
    if request.get('image') and '$image' not in args.values():
        raise ValueError('Space does not map the reference image')
    values = {'$prompt': request['prompt'], '$seconds': request['seconds'],
              '$image': handle_file(request['image']) if request.get('image') else None,
              '$width': 704 if request['aspect'] == '9:16' else 1280,
              '$height': 1280 if request['aspect'] == '9:16' else 704,
              '$seed': request['seed']}
    return {key: values[value] if isinstance(value, str) and value in values else value
            for key, value in args.items()}


def result_files(result):
    if isinstance(result, str):
        yield result
    elif isinstance(result, (list, tuple)):
        for item in result:
            yield from result_files(item)
    elif isinstance(result, dict):
        for key in ('video', 'path', 'value'):
            if key in result:
                yield from result_files(result[key])


def operate(request):
    backend = os.environ.get('WAN_BACKEND', 'local')
    if backend == 'space':
        if request['action'] == 'check':
            with tempfile.TemporaryDirectory(prefix='wan-check-') as directory:
                client = space_client(directory)
                info = client.view_api(return_format='dict', print_info=False)
                return {'available': os.environ['WAN_SPACE_API_NAME'] in info.get('named_endpoints', {})}
        download_dir = str(Path(request['output']).parent / 'downloads')
        client = space_client(download_dir)
        api_name = os.environ['WAN_SPACE_API_NAME']
        result = client.predict(api_name=api_name, **space_arguments(request))
        # gradio_client downloads output files. Never open arbitrary server paths/URLs.
        candidates = [Path(p) for p in result_files(result) if str(p).lower().endswith('.mp4')]
        downloaded = Path(client.output_dir).resolve()
        for file in candidates:
            resolved = file.resolve()
            if downloaded in resolved.parents and resolved.is_file() and not file.is_symlink():
                if resolved.stat().st_size > 150 * 1024 * 1024:
                    raise ValueError('Video too large')
                shutil.copyfile(resolved, request['output'])
                return {'ok': True}
        raise ValueError('No downloaded MP4 in response')
    if backend != 'local':
        raise ValueError('Unsupported backend')
    repo = Path(os.environ['WAN_REPO_DIR']).resolve()
    model = Path(os.environ['WAN_MODEL_DIR']).resolve()
    if request['action'] == 'check':
        import torch
        # Model inference is still checked by generate.py itself.
        available = (torch.cuda.is_available() and (repo / 'generate.py').is_file()
                     and (model / 'config.json').is_file())
        return {'available': bool(available)}
    size = '704*1280' if request['aspect'] == '9:16' else '1280*704'
    # Wan expects 4n+1 frames; its TI2V model runs at 24 fps.
    frames = 4 * max(1, round(request['seconds'] * 24 / 4)) + 1
    args = [sys.executable, str(repo / 'generate.py'), '--task', 'ti2v-5B',
            '--size', size, '--ckpt_dir', str(model), '--offload_model', 'True',
            '--convert_model_dtype', '--t5_cpu', '--frame_num', str(frames),
            '--prompt', request['prompt'], '--base_seed', str(request['seed']), '--save_file', request['output']]
    if request.get('image'):
        args += ['--image', request['image']]
    subprocess.run(args, cwd=repo, check=True, stdout=sys.stderr, stderr=sys.stderr)
    return {'ok': True}


if __name__ == '__main__':
    request = json.load(sys.stdin)
    try:
        # Dependency/provider prints must not corrupt the JSON protocol or expose tokens.
        with contextlib.redirect_stdout(sys.stderr):
            result = operate(request)
    except Exception:
        result = {'error': 'Wan no está disponible. Revisa instalación, GPU o API/cuota del Space; no se reintentó.'}
    print(json.dumps(result))
