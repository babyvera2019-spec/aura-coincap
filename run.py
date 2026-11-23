"""Local entry point: `python run.py` then open http://127.0.0.1:5000"""
import os

from coincap import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
