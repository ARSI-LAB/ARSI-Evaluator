import importlib.util
import sys
import unittest
from pathlib import Path

module_path = Path(sys.argv.pop(1))
spec = importlib.util.spec_from_file_location("selection", module_path)
selection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selection)


def node(name, cpu, slots, alive=True):
    return {"NodeID": name, "Alive": alive, "Resources": {"CPU": cpu, "evaluator_slot": slots}}


class SelectionTests(unittest.TestCase):
    def test_capacity_and_ties(self):
        nodes = [node("head", 8, 0), node("b", 4, 4), node("a", 4, 4),
                 node("large", 32, 32), node("dead", 99, 99, False), node("cpu", 1, 50)]
        chosen = selection.select_nodes(nodes, 2)
        self.assertEqual([entry["NodeID"] for entry in chosen], ["large", "a"])
        self.assertEqual(selection.node_capacity(nodes[-1]), 1)
        self.assertEqual(len(selection.select_nodes(nodes)), 4)
        self.assertEqual([entry["NodeID"] for entry in selection.select_nodes(nodes, 2)], ["large", "a"])

    def test_unavailable_or_invalid_counts(self):
        for count in [0, -1, 1.5, True, 3]:
            with self.assertRaises(ValueError):
                selection.select_nodes([node("a", 1, 1)], count)
        with self.assertRaises(ValueError):
            selection.select_nodes([node("head", 8, 0)])


unittest.main()
