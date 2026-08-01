#!/usr/bin/env python3

import unittest

from test_deepseek_samples import chat_completions_url


class DeepSeekEndpointTest(unittest.TestCase):
    def test_defaults_to_official_deepseek_endpoint(self):
        self.assertEqual(
            chat_completions_url(),
            "https://api.deepseek.com/chat/completions",
        )

    def test_maps_aliyun_workspace_api_root_to_openai_compatible_endpoint(self):
        self.assertEqual(
            chat_completions_url(
                "https://ws-example.cn-beijing.maas.aliyuncs.com/api/v1"
            ),
            "https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
        )

    def test_preserves_complete_chat_completions_endpoint(self):
        self.assertEqual(
            chat_completions_url("https://model.example/v1/chat/completions"),
            "https://model.example/v1/chat/completions",
        )


if __name__ == "__main__":
    unittest.main()
