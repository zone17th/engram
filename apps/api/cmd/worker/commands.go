package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"sort"

	"github.com/zone17th/engram/apps/api/internal/config"
)

// Command mô tả một subcommand vận hành của binary worker (mục 2.22).
//
// Mỗi subcommand tự phân tích cờ bằng flag.NewFlagSet(name, flag.ContinueOnError);
// khi Run trả về flag.ErrHelp thì dispatch trả mã thoát 0.
//
// Quy tắc riêng tư (mục 2.22): các lệnh KHÔNG ĐƯỢC in hoặc trả về trong error
// tên item, hint, tên tag, nội dung câu truy vấn (query text) hoặc bí mật
// (secrets) ra Stdout/Stderr hay log; các hàm xử lý (handlers) chỉ được trả về
// lỗi an toàn về quyền riêng tư vì dispatch in trực tiếp "<tên-lệnh>: <err>".
type Command struct {
	Name    string
	Summary string
	Run     func(ctx context.Context, env Env, args []string) error
}

// Env cung cấp cấu hình đã nạp/kiểm tra cùng logger và luồng xuất cho subcommand.
// Các lệnh tự mở pool DB nếu cần (ví dụ semeval chỉ cần cấu hình provider).
type Env struct {
	Cfg    *config.Config
	Logger *slog.Logger
	Stdout io.Writer
	Stderr io.Writer
}

type registry struct {
	m map[string]Command
}

var defaultRegistry = &registry{}

// Register đăng ký một subcommand vào registry mặc định từ hàm init() của từng file lệnh.
// Hàm sẽ panic nếu tên rỗng, Run nil hoặc tên bị trùng.
func Register(c Command) {
	defaultRegistry.register(c)
}

func (r *registry) register(c Command) {
	if c.Name == "" {
		panic("worker command: empty name")
	}
	if c.Run == nil {
		panic("worker command: nil Run for " + c.Name)
	}
	if r.m == nil {
		r.m = make(map[string]Command)
	}
	if _, exists := r.m[c.Name]; exists {
		panic("worker command: duplicate command " + c.Name)
	}
	r.m[c.Name] = c
}

func (r *registry) dispatch(
	ctx context.Context,
	env Env,
	args []string,
	runWorker func(ctx context.Context, env Env) error,
) int {
	if len(args) == 0 {
		if err := runWorker(ctx, env); err != nil {
			return 1
		}
		return 0
	}

	name := args[0]
	if name == "help" || name == "-h" || name == "--help" {
		r.writeHelp(env.Stdout)
		return 0
	}

	cmd, ok := r.m[name]
	if !ok {
		_, _ = fmt.Fprintln(env.Stderr, "lệnh không biết")
		r.writeHelp(env.Stderr)
		return 2
	}

	if err := cmd.Run(ctx, env, args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		// cmd.Name là tên lệnh đã đăng ký (đáng tin cậy); handler chịu trách nhiệm
		// chỉ trả về error không chứa nội dung nhạy cảm (mục 2.22).
		_, _ = fmt.Fprintf(env.Stderr, "%s: %v\n", cmd.Name, err)
		return 1
	}
	return 0
}

func (r *registry) writeHelp(w io.Writer) {
	_, _ = fmt.Fprintln(w, "dùng: worker [<lệnh> [cờ...]]")
	if len(r.m) == 0 {
		return
	}
	names := make([]string, 0, len(r.m))
	for name := range r.m {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		cmd := r.m[name]
		_, _ = fmt.Fprintf(w, "  %-12s %s\n", cmd.Name, cmd.Summary)
	}
}
