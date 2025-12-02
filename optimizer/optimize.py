#!/usr/bin/env python3
import sys, json
try:
    from ortools.sat.python import cp_model
except Exception as e:
    print('OR-Tools not installed. Install with: pip install ortools', file=sys.stderr)
    sys.exit(2)

def load_json(p):
    with open(p,'r') as f:
        return json.load(f)

def main():
    if len(sys.argv) < 3:
        print('Usage: optimize.py students.json halls.json', file=sys.stderr)
        sys.exit(1)
    students = load_json(sys.argv[1])
    halls = load_json(sys.argv[2])
    benches = []
    for h in halls:
        for b in range(1, h['benches']+1):
            benches.append((h['hall_id'], b))
    S = len(students)
    B = len(benches)
    model = cp_model.CpModel()
    x = {}
    for i in range(S):
        for j in range(B):
            x[(i,j)] = model.NewBoolVar(f"x_{i}_{j}")
    for i in range(S):
        model.Add(sum(x[(i,j)] for j in range(B)) <= 1)
    for j in range(B):
        model.Add(sum(x[(i,j)] for i in range(S)) <= 1)
    model.Maximize(sum(x[(i,j)] for i in range(S) for j in range(B)))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 10
    solver.parameters.num_search_workers = 8
    res = solver.Solve(model)
    if res == cp_model.OPTIMAL or res == cp_model.FEASIBLE:
        out = []
        for j in range(B):
            for i in range(S):
                if solver.Value(x[(i,j)]) == 1:
                    out.append({'bench': j+1, 'student': students[i]})
        print(json.dumps(out))
    else:
        print('No solution', file=sys.stderr)
        sys.exit(3)

if __name__ == '__main__':
    main()
